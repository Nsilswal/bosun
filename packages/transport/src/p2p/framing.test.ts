import { describe, expect, it } from "vitest";
import {
  biStreamToRawSocket,
  type IrohBiStream,
  type IrohConnection,
} from "./framing.js";

/**
 * Exercises the length-prefixed framing over a fake iroh bi-stream — no native
 * addon needed. The real QUIC path is covered by scripts/p2p-loopback.ts.
 */

const enc = (s: string) => Array.from(new TextEncoder().encode(s));

/** A fake RecvStream fed by a queue of bytes, honoring readExact semantics. */
class FakeRecv {
  private buf: number[] = [];
  private waiters: (() => void)[] = [];
  private ended = false;

  feed(bytes: number[]): void {
    this.buf.push(...bytes);
    for (const w of this.waiters.splice(0)) w();
  }
  end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w();
  }
  async readExact(size: number): Promise<number[]> {
    while (this.buf.length < size) {
      if (this.ended) throw new Error("stream ended");
      await new Promise<void>((r) => this.waiters.push(r));
    }
    return this.buf.splice(0, size);
  }
}

class FakeSend {
  written: number[] = [];
  finished = false;
  async writeAll(buf: number[]): Promise<void> {
    // Simulate async so write ordering is actually exercised.
    await Promise.resolve();
    this.written.push(...buf);
  }
  async finish(): Promise<void> {
    this.finished = true;
  }
}

function fakeStream() {
  const recv = new FakeRecv();
  const send = new FakeSend();
  const bi: IrohBiStream = { get send() { return send; }, get recv() { return recv; } };
  let onClosed: () => void = () => {};
  const conn: IrohConnection = {
    openBi: async () => bi,
    acceptBi: async () => bi,
    close: () => onClosed(),
    closed: () => new Promise(() => {}), // never resolves in tests
  };
  return { recv, send, conn, bi };
}

function frameOf(s: string): number[] {
  const body = enc(s);
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, body.length, true);
  return [...header, ...body];
}

describe("biStreamToRawSocket framing", () => {
  it("decodes length-prefixed frames into discrete messages", async () => {
    const { recv, conn, bi } = fakeStream();
    const socket = biStreamToRawSocket(conn, bi);
    const got: string[] = [];
    socket.onMessage((m) => got.push(m));

    // Two frames delivered in one chunk, plus a split frame.
    recv.feed([...frameOf("hello"), ...frameOf("world")]);
    await new Promise((r) => setTimeout(r, 5));
    const split = frameOf("split");
    recv.feed(split.slice(0, 3));
    await new Promise((r) => setTimeout(r, 5));
    recv.feed(split.slice(3));
    await new Promise((r) => setTimeout(r, 5));

    expect(got).toEqual(["hello", "world", "split"]);
  });

  it("length-prefixes and serializes writes", async () => {
    const { send, conn, bi } = fakeStream();
    const socket = biStreamToRawSocket(conn, bi);
    socket.send("ab");
    socket.send("cde");
    await new Promise((r) => setTimeout(r, 20));
    // Two frames, in order, each with a 4-byte LE header.
    expect(send.written).toEqual([...frameOf("ab"), ...frameOf("cde")]);
  });

  it("fires onClose when the read stream ends", async () => {
    const { recv, conn, bi } = fakeStream();
    const socket = biStreamToRawSocket(conn, bi);
    let closed = false;
    socket.onClose(() => {
      closed = true;
    });
    recv.end();
    await new Promise((r) => setTimeout(r, 5));
    expect(closed).toBe(true);
  });
});
