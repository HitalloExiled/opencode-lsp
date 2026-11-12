import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LspPool } from "../src/pool.js";
import type { Settings } from "../src/settings.js";
import { lspTools } from "../src/tools.js";
import { makeTempDir } from "./tmp.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string> = { "src/app.ts": "export const x = 1\n" }): string {
  const root = makeTempDir("opencode-lsp-tools-");
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

function tool(name: string, pool: LspPool, root: string, extra: Partial<Settings> = {}) {
  const found = lspTools(pool, root, settings(extra)).find((item) => item.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found as any;
}

const ctx = { signal: new AbortController().signal } as any;

function stubPool(result: (capability: string) => unknown): LspPool {
  return {
    request: async (_file: string, capability: string) => {
      const value = result(capability);
      return Array.isArray(value) ? value : [value];
    },
  } as unknown as LspPool;
}

describe("lsp tools", () => {
  test("rejects positions below 1", () => {
    const root = project();
    const definition = tool("definition", stubPool(() => null), root);
    expect(() => definition.input.parse({ path: "src/app.ts", line: 0, character: 1 })).toThrow();
    expect(definition.input.parse({ path: "src/app.ts", line: 1, character: 1 })).toEqual({
      path: "src/app.ts",
      line: 1,
      character: 1,
    });
  });

  test("formats definition locations as path:line:character", async () => {
    const root = project();
    const file = join(root, "src/app.ts");
    const definition = tool(
      "definition",
      stubPool(() => [
        {
          uri: pathToFileURL(file).href,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        },
      ]),
      root,
    );

    const result = await definition.execute({ path: "src/app.ts", line: 1, character: 1 }, ctx);
    expect(result.content).toBe("src/app.ts:1:1");
    expect(result.metadata).toEqual({ operation: "goToDefinition", path: "src/app.ts" });
  });

  test("refuses paths outside the project", async () => {
    const root = project();
    const outside = project({ "secret.ts": "" });
    const definition = tool("definition", stubPool(() => null), root);

    const result = await definition.execute(
      { path: join(outside, "secret.ts"), line: 1, character: 1 },
      ctx,
    );
    expect(result.content).toStartWith("LSP error:");
    expect(result.content).toContain("outside the project");
    expect(result.metadata).toEqual({ operation: "goToDefinition", error: true });
  });

  test("renders hover markdown", async () => {
    const root = project();
    const hover = tool(
      "hover",
      stubPool(() => [{ contents: { kind: "markdown", value: "**const** x: number" } }]),
      root,
    );

    const result = await hover.execute({ path: "src/app.ts", line: 1, character: 14 }, ctx);
    expect(result.content).toBe("**const** x: number");
  });

  test("caps workspace symbols and points at a narrower query", async () => {
    const root = project();
    const symbols = Array.from({ length: 25 }, (_, index) => ({
      name: `symbol${index}`,
      kind: 12,
      location: {
        uri: pathToFileURL(join(root, "src/app.ts")).href,
        range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
      },
    }));
    const workspace = tool("symbols", stubPool(() => symbols), root);

    const result = await workspace.execute(
      { path: "src/app.ts", scope: "workspace", query: "" },
      ctx,
    );
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(21);
    expect(lines.at(-1)).toBe("... and 5 more; use a more specific query");
  });

  test("returns the server error instead of throwing", async () => {
    const root = project();
    const definition = tool(
      "definition",
      {
        request: async () => {
          throw new Error("No LSP server for this file could start.");
        },
      } as unknown as LspPool,
      root,
    );

    const result = await definition.execute({ path: "src/app.ts", line: 1, character: 1 }, ctx);
    expect(result.content).toContain("No LSP server for this file could start.");
    expect(result.metadata).toEqual({ operation: "goToDefinition", error: true });
  });
});
