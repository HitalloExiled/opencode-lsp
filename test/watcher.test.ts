import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHANGED,
  CREATED,
  DELETED,
  ignored,
  ProjectWatcher,
  type WatchedFileChange,
} from "../src/watcher.js";
import { fsWatcherUnavailable, makeTempDir } from "./tmp.js";

// A live watcher needs inotify instances; a sandbox can exhaust them. The
// runtime degrades gracefully, so these tests skip with the reason instead of
// reporting an environment limit as a failure.
const watchReason = fsWatcherUnavailable();
const withWatcher = test.skipIf(watchReason !== undefined);
const title = (name: string) => (watchReason ? `${name} (skipped: ${watchReason})` : name);

const roots: string[] = [];
const watchers: ProjectWatcher[] = [];

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = makeTempDir("opencode-lsp-watch-");
  roots.push(root);
  const changes: WatchedFileChange[] = [];
  const watcher = new ProjectWatcher(root, (batch) => changes.push(...batch), () => undefined, 30);
  watchers.push(watcher);
  watcher.start();
  return { root, changes };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for the watcher");
}

describe("ProjectWatcher", () => {
  withWatcher(title("reports created, changed and deleted files"), async () => {
    const { root, changes } = setup();
    const file = join(root, "src/app.ts");
    mkdirSync(join(root, "src"));

    writeFileSync(file, "export const x = 1\n");
    await waitFor(() => changes.some((change) => change.type === CREATED));

    writeFileSync(file, "export const x = 2\n");
    await waitFor(() => changes.some((change) => change.type === CHANGED));

    unlinkSync(file);
    await waitFor(() => changes.some((change) => change.type === DELETED));
  });

  withWatcher(title("ignores dependency and build directories"), async () => {
    const { root, changes } = setup();
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });

    writeFileSync(join(root, "node_modules/pkg/index.js"), "x");
    writeFileSync(join(root, "src/app.ts"), "y");
    await waitFor(() => changes.some((change) => change.uri.endsWith("/src/app.ts")));

    expect(changes.some((change) => change.uri.includes("node_modules"))).toBe(false);
  });

  withWatcher(title("ignores log files"), async () => {
    const { root, changes } = setup();
    writeFileSync(join(root, "server.log"), "x");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(changes).toEqual([]);
  });
});

describe("ignored", () => {
  // The filter is the part worth testing without a live watcher: it decides
  // what reaches the language servers.
  const root = "/work";

  test("keeps source files and drops dependencies and build output", () => {
    expect(ignored(root, "/work/src/app.ts")).toBe(false);
    expect(ignored(root, "/work/node_modules/pkg/index.js")).toBe(true);
    expect(ignored(root, "/work/dist/app.js")).toBe(true);
    expect(ignored(root, "/work/build/out.js")).toBe(true);
    expect(ignored(root, "/work/.git/index")).toBe(true);
  });

  test("drops editor and temp noise", () => {
    expect(ignored(root, "/work/src/app.ts~")).toBe(true);
    expect(ignored(root, "/work/src/app.ts.swp")).toBe(true);
    expect(ignored(root, "/work/src/.DS_Store")).toBe(true);
    expect(ignored(root, "/work/server.log")).toBe(true);
    expect(ignored(root, "/work/state.lock")).toBe(true);
  });

  test("drops the root itself and anything outside it", () => {
    expect(ignored(root, "/work")).toBe(true);
    expect(ignored(root, "/elsewhere/file.ts")).toBe(true);
  });
});
