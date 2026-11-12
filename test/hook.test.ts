import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAfterToolHook, touchedFiles, type AfterToolEvent } from "../src/hook.js";
import type { LspPool } from "../src/pool.js";
import type { Settings } from "../src/settings.js";
import { makeTempDir } from "./tmp.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string> = { "src/app.ts": "export const x = 1\n" }): string {
  const root = makeTempDir("opencode-lsp-hook-");
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

function settings(extra: Partial<Settings> = {}): Settings {
  return {
    servers: [],
    diagnostics: true,
    severities: [1],
    diagnosticsTimeoutMs: 500,
    initializeTimeoutMs: 5_000,
    requestTimeoutMs: 1_000,
    warmupTimeoutMs: 100,
    idleShutdownMs: 0,
    maxErrorsPerFile: 20,
    maxOtherFiles: 5,
    maxWorkspaceSymbols: 20,
    debug: false,
    ...extra,
  };
}

function diagnostic(message: string, severity = 1) {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity,
    message,
  };
}

function stubPool(overrides: Partial<LspPool> = {}): LspPool {
  return {
    serversFor: () => [{ id: "fake" }],
    diagnostics: async () => ({ file: undefined, others: new Map() }),
    close: async () => undefined,
    sync: async () => [],
    ...overrides,
  } as unknown as LspPool;
}

function event(partial: Partial<AfterToolEvent> & Pick<AfterToolEvent, "tool" | "input">): AfterToolEvent {
  return {
    status: "completed",
    result: { content: "edited", metadata: {} },
    ...partial,
  };
}

describe("touchedFiles", () => {
  test("collects write targets from the result and the input", () => {
    const root = project();
    const result = touchedFiles(
      event({ tool: "write", input: { path: "src/app.ts" }, result: { output: { target: "src/app.ts" } } }),
      root,
    );
    expect(result.changed).toEqual([join(root, "src/app.ts")]);
    expect(result.deleted).toEqual([]);
  });

  test("splits patch deletes and moves", () => {
    const root = project();
    const result = touchedFiles(
      event({
        tool: "patch",
        input: { patchText: "*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n*** End Patch" },
        result: {
          output: {
            applied: [
              { type: "delete", target: "src/gone.ts" },
              { type: "update", target: "src/new.ts" },
            ],
          },
        },
      }),
      root,
    );
    expect(result.changed).toEqual([join(root, "src/new.ts")]);
    expect(result.deleted).toEqual([join(root, "src/gone.ts"), join(root, "src/old.ts")]);
  });
});

describe("createAfterToolHook", () => {
  test("appends errors and sets metadata for the terminal UI", async () => {
    const root = project();
    const file = join(root, "src/app.ts");
    const pool = stubPool({ diagnostics: async () => ({ file: [diagnostic("boom")], others: new Map() }) });
    const hook = createAfterToolHook(pool, root, settings());
    const target = event({ tool: "edit", input: { path: "src/app.ts" } });

    await hook(target);

    expect(target.result?.content).toContain("LSP errors detected in this file, please fix:");
    expect(target.result?.content).toContain(`<diagnostics file="${file}">`);
    expect(target.result?.content).toContain("ERROR [1:1] boom");
    const diagnostics = target.result?.metadata?.diagnostics as Record<string, unknown>;
    expect(diagnostics["src/app.ts"]).toEqual([diagnostic("boom")]);
    expect(diagnostics[file]).toEqual([diagnostic("boom")]);
  });

  test("appends to an array result", async () => {
    const root = project();
    const pool = stubPool({ diagnostics: async () => ({ file: [diagnostic("boom")], others: new Map() }) });
    const hook = createAfterToolHook(pool, root, settings());
    const target = event({
      tool: "write",
      input: { path: "src/app.ts" },
      result: { content: [{ type: "text", text: "edited" }] },
    });

    await hook(target);
    expect(Array.isArray(target.result?.content)).toBe(true);
    expect((target.result?.content as any[]).at(-1)).toEqual({
      type: "text",
      text: expect.stringContaining("ERROR [1:1] boom"),
    });
  });

  test("ignores warnings when only errors are selected", async () => {
    const root = project();
    const pool = stubPool({
      diagnostics: async () => ({ file: [diagnostic("careful", 2)], others: new Map() }),
    });
    const hook = createAfterToolHook(pool, root, settings());
    const target = event({ tool: "edit", input: { path: "src/app.ts" } });

    await hook(target);
    expect(target.result?.content).toBe("edited");
    expect(target.result?.metadata).toEqual({});
  });

  test("ignores tools that do not mutate files", async () => {
    const root = project();
    let called = 0;
    const pool = stubPool({
      diagnostics: async () => {
        called++;
        return { file: [], others: new Map() };
      },
    });
    const hook = createAfterToolHook(pool, root, settings());
    await hook(event({ tool: "bash", input: {} }));
    expect(called).toBe(0);
  });

  test("warms the server on read", async () => {
    const root = project();
    const synced: string[] = [];
    const pool = stubPool({
      sync: async (file: string) => {
        synced.push(file);
        return [];
      },
    });
    const hook = createAfterToolHook(pool, root, settings());

    await hook(event({ tool: "read", input: { path: "src/app.ts" }, result: { content: "" } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(synced).toEqual([join(root, "src/app.ts")]);
  });

  test("closes deleted files without asking for diagnostics", async () => {
    const root = project();
    const closed: string[] = [];
    let diagnosed = 0;
    const pool = stubPool({
      close: async (file: string) => {
        closed.push(file);
      },
      diagnostics: async () => {
        diagnosed++;
        return { file: [], others: new Map() };
      },
    });
    const hook = createAfterToolHook(pool, root, settings());

    await hook(
      event({
        tool: "write",
        input: {},
        result: { output: { applied: [{ type: "delete", target: "src/app.ts" }] } },
      }),
    );
    expect(closed).toEqual([join(root, "src/app.ts")]);
    expect(diagnosed).toBe(0);
  });

  test("caps the other-file blocks", async () => {
    const root = project({
      "src/app.ts": "",
      "src/a.ts": "",
      "src/b.ts": "",
      "src/c.ts": "",
    });
    const others = new Map<string, any[]>([
      [pathToFileURL(join(root, "src/a.ts")).href, [diagnostic("a")]],
      [pathToFileURL(join(root, "src/b.ts")).href, [diagnostic("b")]],
      [pathToFileURL(join(root, "src/c.ts")).href, [diagnostic("c")]],
    ]);
    const pool = stubPool({ diagnostics: async () => ({ file: [diagnostic("here")], others }) });
    const hook = createAfterToolHook(pool, root, settings({ maxOtherFiles: 2 }));
    const target = event({ tool: "write", input: { path: "src/app.ts" } });

    await hook(target);
    const text = String(target.result?.content);
    expect(text).toContain("LSP errors detected in other files:");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("src/b.ts");
    expect(text).not.toContain("src/c.ts");
  });

  test("does nothing when the tool failed", async () => {
    const root = project();
    let called = 0;
    const pool = stubPool({
      diagnostics: async () => {
        called++;
        return { file: [], others: new Map() };
      },
    });
    const hook = createAfterToolHook(pool, root, settings());
    await hook(event({ tool: "edit", input: { path: "src/app.ts" }, status: "error" }));
    expect(called).toBe(0);
  });
});
