import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHANGED,
  CREATED,
  DELETED,
  ProjectWatcher,
  type WatchedFileChange,
} from "../src/watcher.js";
import { makeTempDir } from "./tmp.js";

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
  test("reports created, changed and deleted files", async () => {
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

  test("ignores dependency and build directories", async () => {
    const { root, changes } = setup();
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });

    writeFileSync(join(root, "node_modules/pkg/index.js"), "x");
    writeFileSync(join(root, "src/app.ts"), "y");
    await waitFor(() => changes.some((change) => change.uri.endsWith("/src/app.ts")));

    expect(changes.some((change) => change.uri.includes("node_modules"))).toBe(false);
  });

  test("ignores log files", async () => {
    const { root, changes } = setup();
    writeFileSync(join(root, "server.log"), "x");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(changes).toEqual([]);
  });
});
