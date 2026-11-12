import { access, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { BUILTIN_SERVERS, languageIdFor } from "./catalog.js";
import { LspClient, type Diagnostic } from "./client.js";
import { DiagnosticsHub } from "./diagnostics.js";
import { extensionKey, readInside } from "./paths.js";
import type { ServerConfig, Settings } from "./settings.js";
import { DocumentVersions, UriQueue, abortable } from "./sync.js";
import { ProjectWatcher, type WatchedFileChange } from "./watcher.js";

/** Servers answer pull requests quickly or not at all. */
const PULL_TIMEOUT_MS = 3_000;
const PULL_ATTEMPTS = 3;
interface Target {
  /** One client per server and root, as OpenCode V1 ran them. */
  readonly key: string;
  readonly server: ServerConfig;
  readonly root: string;
}

interface Entry {
  readonly key: string;
  client?: LspClient;
  starting?: Promise<LspClient>;
  broken?: string;
  warmed?: boolean;
  readonly opened: Set<string>;
  idle?: ReturnType<typeof setTimeout>;
}

interface Synced {
  readonly client: LspClient;
  readonly version: number;
  /** When this version reached the client; earlier reports describe older contents. */
  readonly sentAt: number;
}

export interface FileDiagnostics {
  /** Diagnostics for the requested file, merged across its servers. */
  readonly file?: Diagnostic[];
  /** Other files whose diagnostics a server published while this file was checked. */
  readonly others: Map<string, Diagnostic[]>;
}

/** The directory a server runs in for this file, or undefined when it does not apply. */
export async function serverRoot(
  id: string,
  file: string,
  project: string,
): Promise<string | undefined> {
  const rule = BUILTIN_SERVERS[id]?.root;
  if (!rule) return project;
  if (rule.exclude && (await nearest(file, project, rule.exclude))) return undefined;
  const found = await nearest(file, project, rule.markers);
  if (!found) return rule.required ? undefined : project;
  return id === "rust" ? cargoWorkspace(found, project) : found;
}

/** The nearest directory from the file's up to `stop` holding one of `markers`. */
async function nearest(
  file: string,
  stop: string,
  markers: readonly string[],
): Promise<string | undefined> {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    for (const marker of markers) {
      if (await access(join(dir, marker)).then(() => true, () => false)) return dir;
    }
    if (dir === stop || dir === dirname(dir)) return undefined;
  }
}

/** The nearest directory from the crate up to the project whose Cargo.toml declares a workspace. */
async function cargoWorkspace(crate: string, project: string): Promise<string> {
  for (let dir = crate; ; dir = dirname(dir)) {
    let manifest: string | undefined;
    try {
      manifest = await readFile(join(dir, "Cargo.toml"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // `[workspace]` as a table header; `[workspace.package]` is not the workspace root.
    if (manifest !== undefined && /^[ \t]*\[workspace\][ \t]*$/m.test(manifest)) return dir;
    if (dir === project || dir === dirname(dir)) return crate;
  }
}

export class LspPool {
  readonly #settings: Settings;
  readonly #root: string;
  readonly #entries = new Map<string, Entry>();
  readonly #versions = new DocumentVersions();
  readonly #queue = new UriQueue();
  readonly #hub = new DiagnosticsHub();
  #watcher?: ProjectWatcher;
  #closed = false;

  constructor(settings: Settings, root: string) {
    this.#settings = settings;
    this.#root = root;
  }

  serversFor(file: string): ServerConfig[] {
    const key = extensionKey(file);
    const name = basename(file).toLowerCase();
    return this.#settings.servers.filter((server) =>
      server.extensions.some((extension) => extension === key || extension === name),
    );
  }

  async #targets(file: string): Promise<Target[]> {
    const targets: Target[] = [];
    for (const server of this.serversFor(file)) {
      const root = await serverRoot(server.id, file, this.#root);
      if (!root) continue;
      const key = root === this.#root ? server.id : `${server.id} (${relative(this.#root, root)})`;
      targets.push({ key, server, root });
    }
    return targets;
  }

  /** Start any missing servers for the file and send them its current contents. */
  async sync(file: string, signal?: AbortSignal): Promise<Synced[]> {
    signal?.throwIfAborted();
    const uri = pathToFileURL(file).href;
    return abortable(this.#queue.run(uri, () => this.#sync(file, uri, signal)), signal);
  }

  /**
   * Tell servers a deleted file is gone and forget what they reported. The
   * version counter survives, so a recreated file never reuses a version a
   * late report names.
   */
  close(file: string): Promise<void> {
    const uri = pathToFileURL(file).href;
    return this.#queue.run(uri, async () => {
      this.#versions.markDeleted(uri);
      this.#hub.forget(uri);
      for (const entry of this.#entries.values()) {
        if (!entry.opened.delete(uri)) continue;
        if (entry.client?.running) {
          entry.client.notify("textDocument/didClose", { textDocument: { uri } });
        }
      }
    });
  }

  async #sync(file: string, uri: string, signal?: AbortSignal): Promise<Synced[]> {
    signal?.throwIfAborted();
    // OpenCode V1 asked before touching files outside the project; plugins
    // cannot ask, so such files are never sent.
    const text = await readInside(this.#root, file);
    signal?.throwIfAborted();

    const ready: { target: Target; client: LspClient }[] = [];
    for (const target of await this.#targets(file)) {
      signal?.throwIfAborted();
      // Initialization is shared; cancelling one tool must not break another caller's server.
      const client = await abortable(this.#client(target).catch(() => undefined), signal);
      signal?.throwIfAborted();
      if (client) ready.push({ target, client });
    }
    signal?.throwIfAborted();
    if (this.#closed) throw new Error("LSP is shut down");
    if (ready.length === 0) return [];

    // Commit the version only after startup finishes, then notify every client
    // without yielding. A cancelled startup must not make their reports stale.
    const version = this.#versions.next(uri);
    const synced: Synced[] = [];
    for (const { target, client } of ready) {
      const entry = this.#entries.get(target.key)!;
      const sentAt = Date.now();
      if (entry.opened.has(uri)) {
        client.notify("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        });
      } else {
        client.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: languageIdFor(extensionKey(file)), version, text },
        });
        entry.opened.add(uri);
      }
      // Edit tools write to disk, and some servers only re-check on save.
      const save = client.capabilities.textDocumentSync?.save;
      if (save === true || (save && typeof save === "object")) {
        client.notify(
          "textDocument/didSave",
          save?.includeText ? { textDocument: { uri }, text } : { textDocument: { uri } },
        );
      }
      this.#touch(entry);
      synced.push({ client, version, sentAt });
    }
    return synced;
  }

  /** Sync the file and wait for its diagnostics. */
  async diagnostics(
    file: string,
    timeoutMs = this.#settings.diagnosticsTimeoutMs,
    signal?: AbortSignal,
  ): Promise<FileDiagnostics> {
    signal?.throwIfAborted();
    const synced = await this.sync(file, signal).catch((error) => {
      signal?.throwIfAborted();
      this.#log(`${file}: ${message(error)}`);
      return [];
    });
    return this.#reports(file, synced, timeoutMs, signal);
  }

  async #reports(
    file: string,
    synced: Synced[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<FileDiagnostics> {
    const uri = pathToFileURL(file).href;
    const reports = await Promise.all(
      synced.map(({ client, version, sentAt }) =>
        this.#collect(client, uri, version, sentAt, timeoutMs, signal),
      ),
    );
    signal?.throwIfAborted();
    const reported = reports.filter((report): report is Diagnostic[] => report !== undefined);
    const others = this.#hub.others(
      synced.map(({ client, sentAt }) => ({ id: client.id, sentAt })),
      uri,
    );
    return { file: reported.length ? reported.flat() : undefined, others };
  }

  async #collect(
    client: LspClient,
    uri: string,
    version: number,
    since: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Diagnostic[] | undefined> {
    signal?.throwIfAborted();
    if (client.capabilities.diagnosticProvider) {
      try {
        // A pull answers for the contents the server held when the request
        // arrived. Sending it from the file's queue pins that version; if a
        // later sync replaced it meanwhile, ask again.
        for (let attempt = 0; attempt < PULL_ATTEMPTS; attempt++) {
          const { sent, response } = await abortable(
            this.#queue.run(uri, async () => {
              signal?.throwIfAborted();
              const response = client.request(
                "textDocument/diagnostic",
                { textDocument: { uri } },
                Math.min(timeoutMs, PULL_TIMEOUT_MS),
                signal,
              );
              // Cancellation can win before the queue returns this nested promise to its caller.
              void response.catch(() => undefined);
              return { sent: this.#versions.current(uri), response };
            }),
            signal,
          );
          const report = await response;
          if (this.#versions.isDeleted(uri)) return undefined;
          if (sent === undefined || this.#versions.current(uri) !== sent) continue;
          if (report.kind === "full") {
            this.#hub.store(client.id, uri, report.items, sent, sent);
            return report.items;
          }
          return this.#hub.snapshot(client.id, uri)?.diagnostics;
        }
      } catch (error) {
        signal?.throwIfAborted();
        this.#log(`${client.id}: pull diagnostics failed, waiting for a push: ${message(error)}`);
      }
    }
    // An older report describes the file before this change, so no report beats a stale one.
    return this.#hub.waitFor(client.id, uri, version, since, timeoutMs, signal);
  }

  /**
   * Run `send` against every server for the file that advertises `capability`,
   * and concatenate their results. Throws when none can answer.
   */
  async request(
    file: string,
    capability: string,
    send: (client: LspClient) => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    signal?.throwIfAborted();
    if (this.serversFor(file).length === 0) {
      const configured = this.#settings.servers.map((server) => server.id).join(", ") || "none";
      throw new Error(
        `No LSP server available for ${extensionKey(file)}. Configured servers: ${configured}. ` +
          "Install a server for this language or add an explicit lsp entry (lsp:true only enables commands found on PATH).",
      );
    }
    const targets = await abortable(this.#targets(file), signal);
    if (targets.length === 0) {
      throw new Error("No configured LSP server applies to this file's project.");
    }
    const cold = targets.some((target) => !this.#entries.get(target.key)?.warmed);
    // Unlike a hook's check, a query must not go ahead for a file that could not be synced.
    const synced = await this.sync(file, signal);
    if (cold) await this.#reports(file, synced, this.#settings.warmupTimeoutMs, signal);
    signal?.throwIfAborted();

    const clients: LspClient[] = [];
    for (const target of targets) {
      const entry = this.#entries.get(target.key);
      if (!entry?.client?.running) continue;
      entry.warmed = true;
      this.#touch(entry);
      clients.push(entry.client);
    }
    if (clients.length === 0) {
      const reasons = targets.map(
        (target) => `${target.key}: ${this.#entries.get(target.key)?.broken ?? "not running"}`,
      );
      throw new Error(`No LSP server for this file could start. ${reasons.join("; ")}`);
    }
    const capable = clients.filter((client) => client.capabilities[capability]);
    if (capable.length === 0) {
      throw new Error(`No LSP server for this file supports ${capability}.`);
    }
    const results = await Promise.all(capable.map(send));
    return results.flatMap((result) =>
      result === null || result === undefined ? [] : Array.isArray(result) ? result : [result],
    );
  }

  async #client(target: Target): Promise<LspClient> {
    if (this.#closed) throw new Error("LSP is shut down");
    let entry = this.#entries.get(target.key);
    if (!entry) {
      entry = { key: target.key, opened: new Set() };
      this.#entries.set(target.key, entry);
    }
    if (entry.client?.failure) entry.broken = entry.client.failure.message;
    if (entry.broken) throw new Error(entry.broken);
    if (entry.client?.running) {
      this.#touch(entry);
      return entry.client;
    }
    if (entry.starting) return entry.starting;

    const current = entry;
    current.opened.clear();
    current.warmed = false;
    this.#hub.forgetServer(target.key);

    const client = new LspClient({
      id: target.key,
      command: target.server.command,
      root: target.root,
      rootUri: pathToFileURL(target.root).href,
      env: target.server.env,
      initialization: target.server.initialization,
      initializeTimeoutMs: this.#settings.initializeTimeoutMs,
      requestTimeoutMs: this.#settings.requestTimeoutMs,
      onDiagnostics: (uri, diagnostics, version) => {
        this.#hub.store(target.key, uri, diagnostics, version, this.#versions.current(uri));
      },
      onActivity: () => this.#hub.activity(target.key),
      onExit: (failure) => {
        if (failure) current.broken = failure.message;
        if (current.client === client) current.client = undefined;
      },
      debug: this.#settings.debug,
    });

    current.starting = client
      .start()
      .then(() => {
        current.client = client;
        this.#log(`${target.key} started`);
        this.#touch(current);
        this.#watch();
        return client;
      })
      .catch(async (error) => {
        // A server that cannot start stays off for this instance instead of
        // costing every edit a retry.
        current.broken = message(error);
        this.#log(current.broken);
        await client.stop();
        throw error;
      })
      .finally(() => {
        current.starting = undefined;
      });
    return current.starting;
  }

  #touch(entry: Entry): void {
    if (this.#settings.idleShutdownMs <= 0) return;
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => {
      void this.#idle(entry);
    }, this.#settings.idleShutdownMs);
  }

  /** External edits (scripts, git, formatters) reach the servers through one project watcher. */
  #watch(): void {
    if (this.#watcher) return;
    this.#watcher = new ProjectWatcher(
      this.#root,
      (changes) => this.#broadcast(changes),
      (message) => this.#log(message),
    );
    this.#watcher.start();
  }

  #broadcast(changes: WatchedFileChange[]): void {
    // Reports for the old contents would otherwise outlive the change.
    for (const change of changes) this.#hub.forget(change.uri);
    let delivered = 0;
    for (const entry of this.#entries.values()) {
      const client = entry.client;
      if (!client?.running) continue;
      client.notify("workspace/didChangeWatchedFiles", { changes });
      delivered++;
    }
    if (delivered > 0) {
      this.#log(`notified ${delivered} server(s) of ${changes.length} external change(s)`);
    }
  }

  async #idle(entry: Entry): Promise<void> {
    entry.idle = undefined;
    const client = entry.client;
    if (!client) return;
    entry.client = undefined;
    entry.opened.clear();
    entry.warmed = false;
    this.#hub.forgetServer(client.id);
    await client.stop().catch(() => undefined);
    this.#log(`${client.id} stopped after idle`);
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    this.#watcher?.stop();
    this.#watcher = undefined;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.idle) clearTimeout(entry.idle);
        const client = entry.client ?? (await entry.starting?.catch(() => undefined));
        await client?.stop();
      }),
    );
  }

  #log(message: string): void {
    if (this.#settings.debug) console.error(`[lsp] ${message}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
