import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** LSP FileChangeType. */
export const CREATED = 1;
export const CHANGED = 2;
export const DELETED = 3;

export interface WatchedFileChange {
  readonly uri: string;
  readonly type: 1 | 2 | 3;
}

const IGNORED_SEGMENTS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "bin",
  "obj",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "vendor",
  ".venv",
  "__pycache__",
  ".tmp",
]);

const IGNORED_SUFFIXES = ["~", ".swp", ".swo", ".tmp", ".lock", ".log", ".pid"];

/** Changes made outside the tool calls (scripts, git, formatters) still reach the servers. */
export class ProjectWatcher {
  readonly #root: string;
  readonly #onChange: (changes: WatchedFileChange[]) => void;
  readonly #log: (message: string) => void;
  readonly #debounceMs: number;
  readonly #pending = new Set<string>();
  readonly #seen = new Set<string>();
  #watcher?: FSWatcher;
  #timer?: ReturnType<typeof setTimeout>;
  #flushing = false;

  constructor(
    root: string,
    onChange: (changes: WatchedFileChange[]) => void,
    log: (message: string) => void,
    debounceMs = 250,
  ) {
    this.#root = root;
    this.#onChange = onChange;
    this.#log = log;
    this.#debounceMs = debounceMs;
  }

  start(): void {
    if (this.#watcher) return;
    try {
      this.#watcher = watch(this.#root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const file = join(this.#root, String(filename));
        if (ignored(this.#root, file)) return;
        this.#pending.add(file);
        this.#schedule();
      });
      this.#watcher.on("error", (error) => {
        this.#log(`watcher stopped: ${message(error)}`);
        this.stop();
      });
      this.#log(`watching ${this.#root}`);
    } catch (error) {
      // A missing watcher only means external edits are not announced; the
      // tool-driven sync keeps working.
      this.#log(`watcher unavailable: ${message(error)}`);
    }
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#pending.clear();
  }

  #schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flush();
    }, this.#debounceMs);
  }

  #flush(): void {
    if (this.#flushing) {
      this.#schedule();
      return;
    }
    if (this.#pending.size === 0) return;
    const pending = [...this.#pending];
    this.#pending.clear();
    this.#flushing = true;
    void this.#resolve(pending).finally(() => {
      this.#flushing = false;
      if (this.#pending.size > 0) this.#schedule();
    });
  }

  async #resolve(pending: string[]): Promise<void> {
    const changes: WatchedFileChange[] = [];
    for (const file of pending) {
      const exists = await stat(file).then(
        (value) => value.isFile(),
        () => false,
      );
      // The first announcement of a file that exists is "created"; a known
      // file is "changed"; a missing one is "deleted".
      const type: 1 | 2 | 3 = !exists ? DELETED : this.#seen.has(file) ? CHANGED : CREATED;
      if (exists) this.#seen.add(file);
      else this.#seen.delete(file);
      changes.push({ uri: pathToFileURL(file).href, type });
    }
    if (changes.length > 0) this.#onChange(changes);
  }
}

function ignored(root: string, file: string): boolean {
  const rel = relative(root, file);
  if (!rel || rel.startsWith("..")) return true;
  const segments = rel.split(sep);
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return true;
  const name = segments[segments.length - 1] ?? "";
  return name === ".DS_Store" || IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
