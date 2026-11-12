import { mkdirSync, mkdtempSync } from "node:fs";
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
