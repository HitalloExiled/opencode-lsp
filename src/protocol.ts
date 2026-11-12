/**
 * LSP wire format: `Content-Length` headers followed by a JSON body.
 *
 * The limits are deliberately small: a language server that sends a runaway
 * header or body is broken, and disabling it is better than growing the
 * plugin's memory without bound.
 */

export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export interface FrameBatch {
  /** Complete messages read before the stream broke (or all of them when it did not). */
  readonly messages: unknown[];
  /** Set when the stream is invalid; the reader stops at the offending frame. */
  readonly error?: ProtocolError;
}

/**
 * Incremental parser for a stream of LSP frames.
 *
 * A malformed frame does not discard the valid messages that preceded it in the
 * same chunk: they are returned together with the error so the caller can
 * deliver them first and then disable the server.
 */
export class FrameReader {
  #buffer: Buffer = Buffer.alloc(0);

  /** Feed a chunk and return every message it finished. */
  push(chunk: Buffer): FrameBatch {
    if (chunk.length > 0) {
      this.#buffer =
        this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    }

    const messages: unknown[] = [];
    try {
      for (;;) {
        const headerEnd = this.#buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          if (this.#buffer.length > MAX_HEADER_BYTES + 4) {
            throw new ProtocolError("header exceeds limit");
          }
          break;
        }
        if (headerEnd > MAX_HEADER_BYTES) throw new ProtocolError("header exceeds limit");

        const length = contentLength(this.#buffer.subarray(0, headerEnd).toString("ascii"));
        const bodyStart = headerEnd + 4;
        if (this.#buffer.length < bodyStart + length) break;

        const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
        this.#buffer = this.#buffer.subarray(bodyStart + length);
        try {
          messages.push(JSON.parse(body));
        } catch {
          throw new ProtocolError("body is not valid JSON");
        }
      }
    } catch (error) {
      return {
        messages,
        error: error instanceof ProtocolError ? error : new ProtocolError(String(error)),
      };
    }
    return { messages };
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
  }
}

/** Encode one JSON-RPC message for the server's stdin. */
export function frame(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function contentLength(header: string): number {
  const lengths = header
    .split("\r\n")
    .filter((line) => /^content-length:/i.test(line));
  if (lengths.length !== 1) throw new ProtocolError("missing or duplicate Content-Length");
  const match = /^content-length: *([0-9]+) *$/i.exec(lengths[0]!);
  if (!match) throw new ProtocolError("invalid Content-Length");
  const length = Number(match[1]);
  if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) {
    throw new ProtocolError("body exceeds limit");
  }
  return length;
}
