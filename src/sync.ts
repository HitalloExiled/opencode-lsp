/**
 * Document bookkeeping shared by the server pool.
 *
 * One queue per URI keeps `didOpen`/`didChange`/`didSave` in order even when
 * two tools touch the same file at once. Versions are monotonic per URI and
 * survive a close, so a late report for a deleted file can never be mistaken
 * for a report about its replacement.
 */

/** Run one task per URI at a time, in arrival order. */
export class UriQueue {
  readonly #queues = new Map<string, Promise<void>>();

  run<T>(uri: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(uri) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(uri, tail);
    void tail.then(() => {
      if (this.#queues.get(uri) === tail) this.#queues.delete(uri);
    });
    return result;
  }
}

export class DocumentVersions {
  readonly #versions = new Map<string, number>();
  readonly #deleted = new Set<string>();

  /** Allocate the next version for a URI and mark it live again. */
  next(uri: string): number {
    const version = (this.#versions.get(uri) ?? 0) + 1;
    this.#versions.set(uri, version);
    this.#deleted.delete(uri);
    return version;
  }

  current(uri: string): number | undefined {
    return this.#versions.get(uri);
  }

  markDeleted(uri: string): void {
    this.#deleted.add(uri);
  }

  isDeleted(uri: string): boolean {
    return this.#deleted.has(uri);
  }
}

/** Settle with shared work without cancelling it for other callers. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    // Attach handlers even when already aborted so shared work cannot reject unhandled.
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}
