/**
 * Socket-agnostic client side of the Bosun connection flow. No Node imports:
 * the Expo app drives this with React Native's WebSocket, the Node test
 * client with `ws`. Both run the identical pairing + handshake logic.
 */
import {
  EnvelopeSchema,
  PreAuthMessageSchema,
  type Envelope,
  type PairRequest,
} from "@bosun/protocol";
import {
  acceptWelcome,
  createHello,
  type Identity,
  type SessionCrypto,
} from "./crypto.js";
import type { PeerConnection, Unsubscribe } from "./types.js";

// The app imports ONLY this subpath (@bosun/transport/client-core): it must
// stay free of Node-only modules, so re-export the pure pieces from here.
export * from "./crypto.js";
export type {
  PairedSupervisor,
  PeerConnection,
  Unsubscribe,
} from "./types.js";

/** Minimal socket surface both `ws` and React Native WebSocket satisfy. */
export interface RawSocket {
  send(data: string): void;
  close(): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
}

export class HandshakeError extends Error {}

/**
 * Run the client connection flow on an OPEN socket:
 *  1. optional pair.request / pair.ok exchange (first connection only)
 *  2. hs.hello / hs.welcome mutual authentication
 * Resolves to an authenticated PeerConnection.
 */
export function connectClient(
  socket: RawSocket,
  identity: Identity,
  opts: {
    /** Pin the server key (always set except during first pairing). */
    expectedServerPublicKey?: string;
    /** Provide to pair before authenticating. */
    pairing?: Omit<PairRequest, "type" | "devicePublicKey">;
    timeoutMs?: number;
  } = {},
): Promise<PeerConnection> {
  return new Promise<PeerConnection>((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    let settled = false;
    const timer = setTimeout(() => {
      fail(new HandshakeError("handshake timed out"));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      reject(err);
    }

    let phase: "pairing" | "hello" | "done" = opts.pairing ? "pairing" : "hello";
    let hello: ReturnType<typeof createHello> | undefined;
    let session: SessionCrypto | undefined;
    const messageListeners = new Set<(env: Envelope) => void>();
    const closeListeners = new Set<() => void>();

    function sendHello(): void {
      hello = createHello(identity);
      socket.send(JSON.stringify(hello.message));
      phase = "hello";
    }

    socket.onClose(() => {
      fail(new HandshakeError("connection closed during handshake"));
      for (const cb of closeListeners) cb();
    });

    socket.onMessage((data) => {
      if (phase === "done") {
        const opened = session!.open(data);
        if (opened === null) return; // undecryptable frame: drop
        const parsed = EnvelopeSchema.safeParse(opened);
        if (!parsed.success) return;
        for (const cb of messageListeners) cb(parsed.data);
        return;
      }

      let preAuth;
      try {
        preAuth = PreAuthMessageSchema.parse(JSON.parse(data));
      } catch {
        fail(new HandshakeError("malformed pre-auth message from server"));
        return;
      }

      if (phase === "pairing") {
        if (preAuth.type === "pair.ok") {
          sendHello();
        } else if (preAuth.type === "pair.error") {
          fail(new HandshakeError(`pairing rejected: ${preAuth.message}`));
        } else {
          fail(new HandshakeError(`unexpected ${preAuth.type} while pairing`));
        }
        return;
      }

      // phase === "hello"
      if (preAuth.type === "hs.reject") {
        fail(new HandshakeError(`server rejected connection: ${preAuth.message}`));
        return;
      }
      if (preAuth.type !== "hs.welcome" || !hello) {
        fail(new HandshakeError(`unexpected ${preAuth.type} during handshake`));
        return;
      }
      const s = acceptWelcome(
        preAuth,
        hello.message,
        hello.state,
        opts.expectedServerPublicKey,
      );
      if (!s) {
        fail(new HandshakeError("server failed authentication"));
        return;
      }
      session = s;
      phase = "done";
      settled = true;
      clearTimeout(timer);
      resolve({
        peerPublicKey: s.peerPublicKey,
        send: (env) => socket.send(s.seal(env)),
        onMessage: (cb): Unsubscribe => {
          messageListeners.add(cb);
          return () => messageListeners.delete(cb);
        },
        onClose: (cb): Unsubscribe => {
          closeListeners.add(cb);
          return () => closeListeners.delete(cb);
        },
        close: () => socket.close(),
      });
    });

    // Kick off.
    if (opts.pairing) {
      const pairMsg: PairRequest = {
        type: "pair.request",
        devicePublicKey: identity.publicKey,
        ...opts.pairing,
      };
      socket.send(JSON.stringify(pairMsg));
    } else {
      sendHello();
    }
  });
}
