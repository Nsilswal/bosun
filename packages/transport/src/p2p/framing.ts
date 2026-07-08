import type { RawSocket } from "../client-core.js";

/**
 * Structural slices of the iroh API we use, so this module type-checks and
 * unit-tests without the native `@number0/iroh` addon present (it's an
 * optional dependency). The real classes are structurally compatible.
 */
export interface IrohSendStream {
  writeAll(buf: number[]): Promise<void>;
  finish(): Promise<void>;
}
export interface IrohRecvStream {
  readExact(size: number): Promise<number[]>;
}
export interface IrohBiStream {
  get send(): IrohSendStream;
  get recv(): IrohRecvStream;
}
export interface IrohConnection {
  openBi(): Promise<IrohBiStream>;
  acceptBi(): Promise<IrohBiStream>;
  close(errorCode: bigint, reason: number[]): void;
  closed(): Promise<unknown>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(message: string): number[] {
  const body = encoder.encode(message);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return Array.from(out);
}

/**
 * Adapt a single iroh bidirectional QUIC stream to the message-oriented
 * `RawSocket` the Bosun handshake and protocol speak. Messages are
 * length-prefixed (4-byte LE) UTF-8 frames. Writes are serialized so
 * concurrent `send()`s can't interleave on the stream.
 */
export function biStreamToRawSocket(
  conn: IrohConnection,
  bi: IrohBiStream,
): RawSocket {
  const messageListeners = new Set<(data: string) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;
  let writeChain: Promise<void> = Promise.resolve();

  const doClose = (): void => {
    if (closed) return;
    closed = true;
    try {
      conn.close(0n, []);
    } catch {
      /* already closing */
    }
    for (const cb of closeListeners) cb();
  };

  const dbg = process.env.BOSUN_P2P_DEBUG
    ? (m: string) => process.stderr.write(`[framing] ${m}\n`)
    : () => {};

  // Read loop: pull length-prefixed frames until the stream ends or errors.
  void (async () => {
    try {
      for (;;) {
        const header = await bi.recv.readExact(4);
        const len = new DataView(new Uint8Array(header).buffer).getUint32(
          0,
          true,
        );
        const body = await bi.recv.readExact(len);
        const text = decoder.decode(new Uint8Array(body));
        for (const cb of messageListeners) cb(text);
      }
    } catch (err) {
      dbg(`read loop ended: ${String(err)}`);
      doClose();
    }
  })();

  // Surface remote-initiated close too.
  void conn.closed().then(doClose, doClose);

  return {
    send: (data) => {
      if (closed) return;
      // Chain writes so they never interleave; drop the connection on error.
      writeChain = writeChain
        .then(() => bi.send.writeAll(frame(data)))
        .catch((e) => {
          dbg(`write error: ${String(e)}`);
          doClose();
        });
    },
    close: doClose,
    onMessage: (cb) => {
      messageListeners.add(cb);
    },
    onClose: (cb) => {
      closeListeners.add(cb);
    },
  };
}
