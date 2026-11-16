import { mkdirSync, mkdtempSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fallback = fileURLToPath(new URL("../.tmp", import.meta.url));

/**
 * A writable temporary directory.
 *
 * `os.tmpdir()` is the normal choice; some sandboxes mount it read-only or
 * without a working mkdtemp, so fall back to the runtime dir and finally to
 * `.tmp/` inside the repo (gitignored).
 */
export function makeTempDir(prefix: string): string {
  const candidates = [process.env.TMPDIR, tmpdir(), process.env.XDG_RUNTIME_DIR, fallback];
  let last: unknown;
  for (const base of candidates) {
    if (!base) continue;
    try {
      mkdirSync(base, { recursive: true });
      return mkdtempSync(join(base, prefix));
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error("no writable temporary directory");
}

/**
 * Why `fs.watch` cannot start here, if it cannot.
 *
 * `fs.watch` needs inotify instances. Containers and desktop sandboxes can
 * exhaust them, failing even on an empty directory with EMFILE/ENOSPC; some
 * kernels reject recursive watching with EINVAL. The runtime degrades
 * gracefully in that case, so tests that need a live watcher skip instead of
 * reporting an environment limit as a regression. Any other error is returned
 * as undefined and left to fail loudly.
 */
export function fsWatcherUnavailable(): string | undefined {
  const dir = makeTempDir("opencode-lsp-probe-");
  try {
    watch(dir).close();
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EMFILE" || code === "ENOSPC" || code === "EINVAL") {
      return `fs.watch unavailable in this environment (${code})`;
    }
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
