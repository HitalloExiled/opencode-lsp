import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspClient, type ClientOptions, type Diagnostic } from "../src/client.js";
import { makeTempDir } from "./tmp.js";

const SERVER = fileURLToPath(new URL("./fake-server.ts", import.meta.url));

const roots: string[] = [];
const clients: LspClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeClient(config: Record<string, unknown>, extra: Partial<ClientOptions> = {}) {
  const root = makeTempDir("opencode-lsp-client-");
  roots.push(root);
  const diagnostics: { uri: string; items: Diagnostic[]; version?: number }[] = [];
  let activity = 0;
  let exit: Error | undefined;

  const client = new LspClient({
    id: "fake",
    command: [process.execPath, SERVER],
    root,
    rootUri: pathToFileURL(root).href,
    env: { FAKE_LSP_CONFIG: JSON.stringify(config) },
    initializeTimeoutMs: 5_000,
    requestTimeoutMs: 1_000,
    onDiagnostics: (uri, items, version) => diagnostics.push({ uri, items, version }),
    onActivity: () => activity++,
    onExit: (failure) => {
      exit = failure;
    },
    debug: false,
    ...extra,
  });
  clients.push(client);
  return { client, root, diagnostics, activity: () => activity, exit: () => exit };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("LspClient", () => {
  test("initializes and exposes capabilities", async () => {
    const { client } = makeClient({ capabilities: { definitionProvider: true, hoverProvider: true } });
    await client.start();
    expect(client.running).toBe(true);
    expect(client.capabilities.definitionProvider).toBe(true);
    expect(client.capabilities.hoverProvider).toBe(true);
  });

  test("returns request results", async () => {
    const uri = "file:///tmp/example.ts";
    const { client } = makeClient({
      capabilities: { definitionProvider: true },
      results: {
        "textDocument/definition": [
          { uri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } } },
        ],
      },
    });
    await client.start();
    const result = await client.request("textDocument/definition", {});
    expect(result).toEqual([
      { uri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } } },
    ]);
  });

  test("receives pushed diagnostics", async () => {
    const uri = "file:///tmp/example.ts";
    const { client, diagnostics } = makeClient({
      capabilities: { textDocumentSync: { save: true } },
      publish: [
        {
          uri,
          items: [
            {
              range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
              severity: 1,
              message: "boom",
            },
          ],
          version: 3,
        },
      ],
    });
    await client.start();
    client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 3, text: "" } });
    await delay(100);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.version).toBe(3);
    expect(diagnostics[0]?.items[0]?.message).toBe("boom");
  });

  test("times out a slow request", async () => {
    const { client } = makeClient({ delays: { "textDocument/hover": 300 } });
    await client.start();
    await expect(client.request("textDocument/hover", {}, 50)).rejects.toThrow("timed out after 50ms");
  });

  test("cancels a request through AbortSignal", async () => {
    const { client } = makeClient({ delays: { "textDocument/hover": 1_000 } });
    await client.start();
    const controller = new AbortController();
    const pending = client.request("textDocument/hover", {}, 5_000, controller.signal);
    setTimeout(() => controller.abort(new Error("stop")), 30);
    await expect(pending).rejects.toThrow("stop");
  });

  test("disables itself on a malformed frame", async () => {
    const { client } = makeClient({ malformed: true });
    await client.start();
    await delay(100);
    expect(client.failure).toBeDefined();
    await expect(client.request("textDocument/hover", {})).rejects.toThrow();
  });

  test("reports a server that exits during initialize", async () => {
    const { client } = makeClient({ exitOnInitialize: true });
    await expect(client.start()).rejects.toThrow();
    expect(client.running).toBe(false);
  });

  test("stops cleanly", async () => {
    const { client } = makeClient({});
    await client.start();
    await client.stop();
    expect(client.running).toBe(false);
  });
});
