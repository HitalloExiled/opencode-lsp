import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspPool } from "../src/pool.js";
import type { Settings } from "../src/settings.js";
import { makeTempDir } from "./tmp.js";

const SERVER = fileURLToPath(new URL("./fake-server.ts", import.meta.url));

const pools: LspPool[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.shutdown().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string> = { "src/app.ts": "export const x = 1\n" }) {
  const root = makeTempDir("opencode-lsp-pool-");
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

function settings(root: string, config: Record<string, unknown>, extra: Partial<Settings> = {}): Settings {
  return {
    servers: [
      {
        id: "fake",
        command: [process.execPath, SERVER],
        extensions: [".ts"],
        env: { FAKE_LSP_CONFIG: JSON.stringify({ ...config, logFile: join(root, "server.log") }) },
      },
    ],
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

function log(root: string): any[] {
  try {
    return readFileSync(join(root, "server.log"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function diagnostic(message: string) {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    message,
  };
}

describe("LspPool", () => {
  test("syncs a file once per change and reports pushed diagnostics", async () => {
    const root = project();
    const file = join(root, "src/app.ts");
    const uri = pathToFileURL(file).href;
    const pool = new LspPool(
      settings(root, {
        capabilities: { textDocumentSync: { save: true } },
        publish: [{ uri, items: [diagnostic("boom")] }],
      }),
      root,
    );
    pools.push(pool);

    await pool.sync(file);
    const result = await pool.diagnostics(file, 1_000);
    expect(result.file?.[0]?.message).toBe("boom");

    await pool.sync(file);
    const messages = log(root).filter((entry) => entry.method?.startsWith("textDocument/"));
    expect(messages.map((entry) => entry.method)).toEqual([
      "textDocument/didOpen",
      "textDocument/didSave",
      "textDocument/didChange",
      "textDocument/didSave",
    ]);
    expect(messages[0]?.params.textDocument.version).toBe(1);
    expect(messages[2]?.params.textDocument.version).toBe(2);
  });

  test("uses pull diagnostics when the server supports them", async () => {
    const root = project();
    const file = join(root, "src/app.ts");
    const pool = new LspPool(
      settings(root, {
        capabilities: { diagnosticProvider: {} },
        pull: { items: [diagnostic("pulled")] },
      }),
      root,
    );
    pools.push(pool);

    const result = await pool.diagnostics(file, 1_000);
    expect(result.file?.[0]?.message).toBe("pulled");
    expect(log(root).some((entry) => entry.method === "textDocument/diagnostic")).toBe(true);
  });

  test("answers navigation requests through the matching capability", async () => {
    const root = project();
    const file = join(root, "src/app.ts");
    const pool = new LspPool(
      settings(root, {
        capabilities: { definitionProvider: true },
        results: {
          "textDocument/definition": [
            {
              uri: pathToFileURL(file).href,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            },
          ],
        },
      }),
      root,
    );
    pools.push(pool);

    const results = await pool.request(file, "definitionProvider", (client) =>
      client.request("textDocument/definition", {}),
    );
    expect(results).toHaveLength(1);
    await expect(
      pool.request(file, "hoverProvider", (client) => client.request("textDocument/hover", {})),
    ).rejects.toThrow("supports hoverProvider");
  });

  test("closes a deleted file and keeps the version counter", async () => {
    const root = project();
    const file = join(root, "src/app.ts");
    const pool = new LspPool(settings(root, { capabilities: { textDocumentSync: { save: true } } }), root);
    pools.push(pool);

    await pool.sync(file);
    await pool.close(file);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const methods = log(root).map((entry) => entry.method);
    expect(methods).toContain("textDocument/didClose");
  });

  test("reports other files published during the check", async () => {
    const root = project({
      "src/app.ts": "export const x = 1\n",
      "src/other.ts": "export const y = 2\n",
    });
    const file = join(root, "src/app.ts");
    const other = join(root, "src/other.ts");
    const pool = new LspPool(
      settings(root, {
        capabilities: { textDocumentSync: { save: true } },
        publish: [
          { uri: pathToFileURL(file).href, items: [diagnostic("here")] },
          { uri: pathToFileURL(other).href, items: [diagnostic("there")] },
        ],
      }),
      root,
    );
    pools.push(pool);

    const result = await pool.diagnostics(file, 1_000);
    expect(result.others.get(pathToFileURL(other).href)?.[0]?.message).toBe("there");
  });

  test("keeps a broken server disabled", async () => {
    const root = project();
    const file = join(root, "src/app.ts");
    const pool = new LspPool(
      {
        ...settings(root, {}),
        servers: [
          {
            id: "fake",
            command: [process.execPath, "-e", "process.exit(1)"],
            extensions: [".ts"],
            env: {},
          },
        ],
      },
      root,
    );
    pools.push(pool);

    await expect(pool.diagnostics(file, 200)).resolves.toEqual({
      file: undefined,
      others: new Map(),
    });
    await expect(
      pool.request(file, "definitionProvider", (client) => client.request("textDocument/definition", {})),
    ).rejects.toThrow("could start");
  });

  test("stops an idle server and restarts it on the next sync", async () => {
    const root = project();
    const file = join(root, "src/app.ts");
    const pool = new LspPool(
      settings(root, { capabilities: { textDocumentSync: { save: true } } }, { idleShutdownMs: 40 }),
      root,
    );
    pools.push(pool);

    await pool.sync(file);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await pool.sync(file);
    const initializes = log(root).filter((entry) => entry.method === "initialize");
    expect(initializes).toHaveLength(2);
  });
});
