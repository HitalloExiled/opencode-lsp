import { spawn, type ChildProcess } from "node:child_process";
import { FrameReader, ProtocolError, frame } from "./protocol.js";

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Diagnostic {
  readonly range: Range;
  readonly severity?: number;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
}

export type DiagnosticReport =
  | { readonly kind: "full"; readonly items: Diagnostic[] }
  | { readonly kind: "unchanged" };

/** A JSON-RPC error that keeps the server's code, so callers can retry transient failures. */
export class LspError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code: number | undefined) {
    super(message);
    this.name = "LspError";
    this.code = code;
  }
}

export interface ClientOptions {
  readonly id: string;
  readonly command: readonly string[];
  readonly root: string;
  readonly rootUri: string;
  readonly env: Record<string, string>;
  readonly initialization?: Record<string, unknown>;
  readonly initializeTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly onDiagnostics: (
    uri: string,
    diagnostics: Diagnostic[],
    version: number | undefined,
  ) => void;
  /** Called for every message from the server; diagnostics waits use it to detect activity. */
  readonly onActivity: () => void;
  readonly onExit: (failure?: Error) => void;
  readonly debug: boolean;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

/** A JSON-RPC 2.0 client for one language server over stdio. */
export class LspClient {
  readonly id: string;
  readonly #options: ClientOptions;
  readonly #reader = new FrameReader();
  readonly #pending = new Map<number, Pending>();
  #child?: ChildProcess;
  #capabilities: Record<string, any> = {};
  #failed?: Error;
  #stopping = false;
  #nextID = 1;

  constructor(options: ClientOptions) {
    this.id = options.id;
    this.#options = options;
  }

  get capabilities(): Record<string, any> {
    return this.#capabilities;
  }

  get failure(): Error | undefined {
    return this.#failed;
  }

  get running(): boolean {
    const child = this.#child;
    return (
      this.#failed === undefined &&
      !this.#stopping &&
      child !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    );
  }

  async start(): Promise<void> {
    const [command, ...args] = this.#options.command;
    if (!command) throw new Error(`${this.id}: no command configured`);

    const child = spawn(command, args, {
      cwd: this.#options.root,
      env: { ...process.env, ...this.#options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.#onData(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      if (this.#options.debug) process.stderr.write(`[lsp:${this.id}] ${chunk}`);
    });
    child.on("exit", (code, signal) => this.#onExit(code, signal));
    // A server that exits while a notification is being written raises EPIPE.
    child.stdin?.on("error", () => undefined);

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) =>
        reject(new Error(`${this.id}: cannot start "${command}": ${error.message}`)),
      );
    });

    const result = await this.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "opencode-lsp", version: "1" },
        rootUri: this.#options.rootUri,
        rootPath: this.#options.root,
        workspaceFolders: [{ uri: this.#options.rootUri, name: "workspace" }],
        initializationOptions: this.#options.initialization ?? {},
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          window: { workDoneProgress: true },
          workspace: {
            configuration: true,
            workspaceFolders: true,
            symbol: {},
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            publishDiagnostics: { versionSupport: true },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            implementation: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            callHierarchy: {},
          },
        },
      },
      this.#options.initializeTimeoutMs,
    );
    this.#capabilities = record(record(result)?.capabilities) ?? {};
    this.notify("initialized", {});
    if (this.#options.initialization) {
      this.notify("workspace/didChangeConfiguration", {
        settings: this.#options.initialization,
      });
    }
  }

  request(
    method: "textDocument/diagnostic",
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<DiagnosticReport>;
  request(
    method: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
  request(
    method: string,
    params: unknown,
    timeoutMs = this.#options.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      if (this.#failed || !this.#child) {
        reject(this.#failed ?? new Error(`${this.id}: server is not running`));
        return;
      }

      const id = this.#nextID++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        cleanup();
        reject(new Error(`${this.id}: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        this.#pending.delete(id);
        cleanup();
        this.notify("$/cancelRequest", { id });
        reject(abortError(signal!));
      };

      this.#pending.set(id, { method, resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    const child = this.#child;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (!this.#failed) {
        await this.request("shutdown", null, 2_000).catch(() => undefined);
        this.#send({ jsonrpc: "2.0", method: "exit" });
      }
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 1_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
    this.#child = undefined;
    this.#rejectPending(new Error(`${this.id}: server stopped`));
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #send(message: Record<string, unknown>): void {
    const stdin = this.#child?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(frame(message));
  }

  #protocolError(error: unknown): void {
    const failure = new Error(`${this.id}: protocol error: ${message(error)}`);
    this.#failed = failure;
    this.#reader.reset();
    this.#rejectPending(failure);
    if (this.#options.debug) console.error(failure.message);
    this.#child?.kill("SIGKILL");
  }

  #onData(chunk: Buffer): void {
    if (this.#failed) return;
    const { messages, error } = this.#reader.push(chunk);
    try {
      for (const value of messages) this.#handle(value);
    } catch (failure) {
      this.#protocolError(failure);
      return;
    }
    if (error) this.#protocolError(error);
  }

  #handle(value: unknown): void {
    const message = record(value);
    if (!message || message.jsonrpc !== "2.0") throw new ProtocolError("invalid JSON-RPC envelope");
    this.#options.onActivity();

    if (message.id !== undefined && message.method === undefined) {
      if (typeof message.id !== "number") throw new ProtocolError("invalid response ID");
      const pending = this.#pending.get(message.id);
      if (!pending) return;

      const error = record(message.error);
      if (message.error !== undefined) {
        if (!error || typeof error.message !== "string" || typeof error.code !== "number") {
          throw new ProtocolError("invalid error response");
        }
      }

      let result = message.result;
      if (pending.method === "textDocument/diagnostic" && !error) {
        result = diagnosticReport(result);
      }

      pending.cleanup();
      this.#pending.delete(message.id);
      if (error) pending.reject(new LspError(`${this.id}: ${error.message}`, error.code as number));
      else pending.resolve(result);
      return;
    }

    if (typeof message.method !== "string") throw new ProtocolError("invalid request method");

    if (message.method === "textDocument/publishDiagnostics") {
      const params = record(message.params);
      if (
        !params ||
        typeof params.uri !== "string" ||
        (params.version !== undefined && !Number.isSafeInteger(params.version))
      ) {
        throw new ProtocolError("invalid diagnostics parameters");
      }
      this.#options.onDiagnostics(
        params.uri,
        diagnosticsFrom(params.diagnostics),
        params.version as number | undefined,
      );
      return;
    }

    if (message.id !== undefined) this.#respond(message.id, message.method, message.params);
  }

  #respond(id: unknown, method: string, params: any): void {
    const reply = (result: unknown) => this.#send({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "workspace/configuration": {
        const items: any[] = Array.isArray(params?.items) ? params.items : [];
        reply(items.map((item) => this.#section(item?.section)));
        return;
      }
      case "workspace/workspaceFolders":
        reply([{ uri: this.#options.rootUri, name: "workspace" }]);
        return;
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
        reply(null);
        return;
      default:
        this.#send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
  }

  /** Answers `workspace/configuration` from the server's `initialization` options. */
  #section(section: unknown): unknown {
    const settings = this.#options.initialization ?? {};
    if (typeof section !== "string" || section === "") return settings;
    let value: any = settings;
    for (const key of section.split(".")) {
      value = value?.[key];
      if (value === undefined) return null;
    }
    return value;
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#child = undefined;
    this.#rejectPending(new Error(`${this.id}: server exited (${code ?? signal})`));
    if (!this.#stopping && this.#options.debug) {
      console.error(`[lsp:${this.id}] exited (${code ?? signal})`);
    }
    this.#options.onExit(this.#failed);
  }
}

/** Send a request, retrying while the server reports that it is still loading. */
export async function requestWithRetry(
  client: LspClient,
  method: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const transient = new Set([-32800, -32801, -32802]);
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await client.request(method, params, undefined, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt >= 5 || !(error instanceof LspError) || !transient.has(error.code ?? 0)) {
        throw error;
      }
      await delay(400 * attempt, signal);
    }
  }
}

export function record(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}

/** Validate the `diagnostics` array from a publish or pull response. */
export function diagnosticsFrom(value: unknown): Diagnostic[] {
  if (
    !Array.isArray(value) ||
    !value.every((item: unknown) => {
      const diagnostic = record(item);
      const range = record(diagnostic?.range);
      return (
        !!diagnostic &&
        !!range &&
        position(range.start) &&
        position(range.end) &&
        typeof diagnostic.message === "string" &&
        (diagnostic.severity === undefined || [1, 2, 3, 4].includes(diagnostic.severity as number)) &&
        (diagnostic.code === undefined ||
          typeof diagnostic.code === "string" ||
          typeof diagnostic.code === "number") &&
        (diagnostic.source === undefined || typeof diagnostic.source === "string")
      );
    })
  ) {
    throw new ProtocolError("invalid diagnostic records");
  }
  return value as Diagnostic[];
}

function diagnosticReport(value: unknown): DiagnosticReport {
  const report = record(value);
  if (report?.kind === "full") return { kind: "full", items: diagnosticsFrom(report.items) };
  if (report?.kind === "unchanged") return { kind: "unchanged" };
  throw new ProtocolError("invalid diagnostic report");
}

function position(value: unknown): boolean {
  const item = record(value);
  return (
    !!item &&
    Number.isSafeInteger(item.line) &&
    (item.line as number) >= 0 &&
    Number.isSafeInteger(item.character) &&
    (item.character as number) >= 0
  );
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
