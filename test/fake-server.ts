/**
 * A scripted language server for the test suite.
 *
 * It speaks the real stdio protocol but answers from the JSON in
 * `FAKE_LSP_CONFIG`, so tests can exercise framing, diagnostics, pull/push,
 * failures and timeouts without installing a language server.
 */

import { appendFileSync } from "node:fs";

interface Config {
  capabilities?: Record<string, unknown>;
  /** Published after didOpen/didChange/didSave. */
  publish?: { uri: string; items: unknown[]; version?: number }[];
  /** Answer `textDocument/diagnostic` with a full report. */
  pull?: { items: unknown[] };
  /** Request results by method. */
  results?: Record<string, unknown>;
  /** Per-method delay in milliseconds. */
  delays?: Record<string, number>;
  /** Send a malformed frame right after initialize. */
  malformed?: boolean;
  /** Exit when `initialize` arrives, before answering it. */
  exitOnInitialize?: boolean;
  logFile?: string;
}

const config: Config = JSON.parse(process.env.FAKE_LSP_CONFIG ?? "{}");
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

let buffer: Buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString("ascii");
    const match = /content-length: *([0-9]+)/i.exec(header);
    if (!match) return;
    const length = Number(match[1]);
    const start = end + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    handle(JSON.parse(body));
  }
});

function send(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function log(entry: unknown): void {
  if (!config.logFile) return;
  appendFileSync(config.logFile, `${JSON.stringify(entry)}\n`);
}

function later(method: string, run: () => void): void {
  const delay = config.delays?.[method] ?? 0;
  if (delay <= 0) {
    run();
    return;
  }
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    run();
  }, delay);
  pendingTimers.add(timer);
}

function handle(message: any): void {
  log(message);
  if (message.method === undefined) return;

  const method: string = message.method;
  const respond = (result: unknown) => {
    if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result });
  };

  switch (method) {
    case "initialize":
      if (config.exitOnInitialize) process.exit(1);
      respond({ capabilities: config.capabilities ?? {} });
      if (config.malformed) {
        process.stdout.write("Content-Length: nope\r\n\r\n");
      }
      return;
    case "initialized":
    case "workspace/didChangeConfiguration":
      return;
    case "shutdown":
      respond(null);
      return;
    case "exit":
      process.exit(0);
    case "textDocument/didOpen":
    case "textDocument/didChange":
    case "textDocument/didSave": {
      const version = message.params?.textDocument?.version;
      for (const report of config.publish ?? []) {
        later(method, () =>
          send({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: {
              uri: report.uri,
              diagnostics: report.items,
              ...((report.version ?? version) !== undefined
                ? { version: report.version ?? version }
                : {}),
            },
          }),
        );
      }
      return;
    }
    case "textDocument/diagnostic":
      later(method, () =>
        respond(config.pull ? { kind: "full", items: config.pull.items } : { kind: "unchanged" }),
      );
      return;
    default:
      later(method, () => respond(config.results?.[method] ?? null));
  }
}

process.on("SIGTERM", () => process.exit(0));
