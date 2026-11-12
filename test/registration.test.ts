import { describe, expect, test } from "bun:test";
import plugin from "../index.js";
import type { LspPool } from "../src/pool.js";
import type { Settings } from "../src/settings.js";
import { registerTools } from "../src/tools.js";

function settings(): Settings {
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
  };
}

interface AddedTool {
  name: string;
  options?: { namespace?: string; pinned?: boolean; permission?: string };
}

describe("lsp registration", () => {
  test("declares the plugin id", () => {
    expect(plugin.id).toBe("lsp");
  });

  test("registers the six tools under the lsp namespace", async () => {
    const added: AddedTool[] = [];
    const namespaces: { name: string }[] = [];
    const ctx = {
      tool: {
        transform: async (
          fn: (editor: {
            namespace: (input: { name: string }) => void;
            add: (tool: AddedTool) => void;
          }) => void,
        ) => {
          fn({
            namespace: (input) => namespaces.push(input),
            add: (tool) => added.push(tool),
          });
          return { dispose: async () => undefined };
        },
      },
    } as never;

    await registerTools(ctx, {} as LspPool, "/tmp/project", settings());

    expect(namespaces[0]?.name).toBe("lsp");
    expect(added.map((tool) => tool.name)).toEqual([
      "definition",
      "references",
      "hover",
      "symbols",
      "implementations",
      "calls",
    ]);
    expect(added.every((tool) => tool.options?.namespace === "lsp")).toBe(true);
    expect(added.every((tool) => tool.options?.permission === "lsp")).toBe(true);
    expect(added.filter((tool) => tool.options?.pinned).map((tool) => tool.name)).toEqual([
      "definition",
      "references",
      "hover",
      "symbols",
    ]);
  });
});
