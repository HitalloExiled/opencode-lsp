import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

/** A file's extension, or `.name` for an extensionless file such as `Dockerfile`. */
export function extensionKey(file: string): string {
  return extname(file).toLowerCase() || `.${basename(file).toLowerCase()}`;
}

/** Whether the file is inside the project before resolving symlinks. */
export function within(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Whether the file, after resolving symlinks, is inside the project. */
export async function insideProject(root: string, file: string): Promise<boolean> {
  if (!within(root, file)) return false;
  const real = await realpath(file).catch(() => undefined);
  return real !== undefined && within(await realpath(root).catch(() => root), real);
}

/**
 * Read a project file, checking the file that was opened rather than the path.
 * Linux names an open descriptor's file under /proc, so no symlink swap can get
 * outside contents past the check. Elsewhere the opened inode must still sit at
 * the resolved path.
 */
export async function readInside(root: string, file: string): Promise<string> {
  const outside = new Error(`${file} is outside the project directory ${root}.`);
  if (!within(root, file)) throw outside;
  const handle = await open(file, "r");
  try {
    const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
    const real = opened ?? (await realpath(file));
    if (!within(await realpath(root).catch(() => root), real)) throw outside;
    if (opened === undefined) {
      const [held, current] = await Promise.all([handle.stat(), lstat(real)]);
      if (current.dev !== held.dev || current.ino !== held.ino) throw outside;
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** A tool's file argument as an absolute path, without OpenCode's `@` prefix. */
export function projectPath(root: string, value: string): string {
  const path = value.replace(/^@/, "");
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

/**
 * Resolve a tool argument to an existing file inside the project. OpenCode V1
 * asked before touching files outside the project; plugins cannot ask, so those
 * files are refused, symlinks included.
 */
export async function resolveProjectFile(root: string, value: string): Promise<string> {
  const file = projectPath(root, value);
  const outside = new Error(`${value} is outside the project directory ${root}.`);
  if (!within(root, file)) throw outside;
  const real = await realpath(file).catch(() => undefined);
  if (!real) throw new Error(`File not found: ${file}`);
  if (!within(await realpath(root).catch(() => root), real)) throw outside;
  if (!(await stat(real)).isFile()) throw new Error(`Not a file: ${file}`);
  return file;
}
