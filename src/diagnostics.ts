import type { Diagnostic } from "./client.js";
import { abortReason } from "./sync.js";

/** A server's latest report for one URI. */
export interface Published {
  readonly diagnostics: Diagnostic[];
  readonly at: number;
  readonly version?: number;
}

/** How long a server must stay quiet before its report is considered complete. */
export const SETTLE_MS = 300;

/**
 * Stores pushed diagnostics and waits for them.
 *
 * Servers that only push (`publishDiagnostics`) need a quiet-period wait: a
 * fast empty report often arrives while the server is still indexing, and
 * taking it as "clean" hides the real errors. Reports older than the version
 * we sent are dropped instead of merged.
 */
export class DiagnosticsHub {
  readonly #published = new Map<string, Map<string, Published>>();
  readonly #listeners = new Map<string, Set<() => void>>();

  store(
    serverID: string,
    uri: string,
    diagnostics: Diagnostic[],
    version: number | undefined,
    latestVersion: number | undefined,
  ): void {
    // A late report for an older version describes contents that are gone.
    const existing = this.#published.get(serverID)?.get(uri);
    const latest = latestVersion ?? existing?.version;
    if (version !== undefined && latest !== undefined && version < latest) return;

    const reports = this.#published.get(serverID) ?? new Map<string, Published>();
    reports.set(uri, { diagnostics, at: Date.now(), version });
    this.#published.set(serverID, reports);
    this.#notify(serverID);
  }

  snapshot(serverID: string, uri: string): Published | undefined {
    return this.#published.get(serverID)?.get(uri);
  }

  /** Drop every report for a URI (deleted file). */
  forget(uri: string): void {
    for (const reports of this.#published.values()) reports.delete(uri);
  }

  /** Drop every report from one server (restart or idle shutdown). */
  forgetServer(serverID: string): void {
    this.#published.delete(serverID);
  }

  /** A message arrived from the server; restart the quiet period of any waiter. */
  activity(serverID: string): void {
    this.#notify(serverID);
  }

  /** Diagnostics for other files that arrived while the requested file was checked. */
  others(
    servers: readonly { readonly id: string; readonly sentAt: number }[],
    uri: string,
  ): Map<string, Diagnostic[]> {
    const others = new Map<string, Diagnostic[]>();
    for (const { id, sentAt } of servers) {
      for (const [other, published] of this.#published.get(id) ?? []) {
        if (other === uri || published.at < sentAt) continue;
        others.set(other, [...(others.get(other) ?? []), ...published.diagnostics]);
      }
    }
    return others;
  }

  /**
   * Resolve once the server has reported for this version and gone quiet, or
   * `undefined` on timeout. No report is better than a stale one.
   */
  waitFor(
    serverID: string,
    uri: string,
    version: number,
    since: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Diagnostic[] | undefined> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let settle: ReturnType<typeof setTimeout> | undefined;
      const listeners = this.#listeners.get(serverID) ?? new Set<() => void>();

      const current = (): Published | undefined => {
        const published = this.#published.get(serverID)?.get(uri);
        if (!published || published.at < since) return undefined;
        if (published.version !== undefined && published.version < version) return undefined;
        return published;
      };
      const cleanup = () => {
        clearTimeout(timeout);
        if (settle) clearTimeout(settle);
        listeners.delete(listener);
        signal?.removeEventListener("abort", abort);
      };
      const finish = () => {
        cleanup();
        resolve(current()?.diagnostics);
      };
      const abort = () => {
        cleanup();
        reject(abortReason(signal!));
      };
      // Any message from the server restarts the quiet period, so an early
      // empty result from a server that is still indexing is not taken as clean.
      const listener = () => {
        if (!current()) return;
        if (settle) clearTimeout(settle);
        settle = setTimeout(finish, SETTLE_MS);
      };
      const timeout = setTimeout(finish, timeoutMs);

      listeners.add(listener);
      this.#listeners.set(serverID, listeners);
      signal?.addEventListener("abort", abort, { once: true });
      listener();
    });
  }

  #notify(serverID: string): void {
    for (const listener of [...(this.#listeners.get(serverID) ?? [])]) listener();
  }
}
