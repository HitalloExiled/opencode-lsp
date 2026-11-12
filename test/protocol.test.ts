import { describe, expect, test } from "bun:test";
import {
  FrameReader,
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  ProtocolError,
  frame,
} from "../src/protocol.js";

describe("FrameReader", () => {
  test("parses one complete frame", () => {
    const reader = new FrameReader();
    expect(reader.push(Buffer.from(frame({ jsonrpc: "2.0", id: 1, result: null }))).messages).toEqual([
      { jsonrpc: "2.0", id: 1, result: null },
    ]);
  });

  test("buffers a frame split across chunks", () => {
    const reader = new FrameReader();
    const bytes = Buffer.from(frame({ jsonrpc: "2.0", method: "x" }));
    expect(reader.push(bytes.subarray(0, 5)).messages).toEqual([]);
    expect(reader.push(bytes.subarray(5, 17)).messages).toEqual([]);
    expect(reader.push(bytes.subarray(17)).messages).toEqual([{ jsonrpc: "2.0", method: "x" }]);
  });

  test("parses several frames in one chunk", () => {
    const reader = new FrameReader();
    const bytes = Buffer.from(frame({ a: 1 }) + frame({ b: 2 }));
    expect(reader.push(bytes).messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("keeps the valid messages before a malformed frame", () => {
    const reader = new FrameReader();
    const bytes = Buffer.from(`${frame({ ok: true })}Content-Length: nope\r\n\r\n`);
    const batch = reader.push(bytes);
    expect(batch.messages).toEqual([{ ok: true }]);
    expect(batch.error).toBeInstanceOf(ProtocolError);
  });

  test("counts bytes, not characters, in Content-Length", () => {
    const reader = new FrameReader();
    expect(reader.push(Buffer.from(frame({ text: "ação" }))).messages).toEqual([{ text: "ação" }]);
  });

  test("rejects a header above the limit", () => {
    const reader = new FrameReader();
    const header = `Content-Length: 2\r\nX-Pad: ${"a".repeat(MAX_HEADER_BYTES)}\r\n\r\n{}`;
    const batch = reader.push(Buffer.from(header));
    expect(batch.error).toBeInstanceOf(ProtocolError);
    expect(batch.messages).toEqual([]);
  });

  test("rejects a body above the limit", () => {
    const reader = new FrameReader();
    const batch = reader.push(Buffer.from(`Content-Length: ${MAX_BODY_BYTES + 1}\r\n\r\n`));
    expect(batch.error?.message).toBe("body exceeds limit");
  });

  test("rejects a missing or duplicate Content-Length", () => {
    const missing = new FrameReader();
    expect(missing.push(Buffer.from("X-Test: 1\r\n\r\n{}")).error).toBeInstanceOf(ProtocolError);
    const duplicate = new FrameReader();
    const batch = duplicate.push(
      Buffer.from("Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}"),
    );
    expect(batch.error).toBeInstanceOf(ProtocolError);
  });

  test("rejects invalid JSON", () => {
    const reader = new FrameReader();
    const batch = reader.push(Buffer.from("Content-Length: 3\r\n\r\n{n}"));
    expect(batch.error?.message).toBe("body is not valid JSON");
  });

  test("reset drops partial state", () => {
    const reader = new FrameReader();
    reader.push(Buffer.from("Content-Length: 20\r\n\r\n{"));
    reader.reset();
    expect(reader.push(Buffer.from(frame({ ok: true }))).messages).toEqual([{ ok: true }]);
  });
});
