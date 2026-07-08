/**
 * Socket-agnostic SERVER side of the Bosun connection flow — the mirror of
 * `client-core`. Any transport (LAN WebSocket, iroh QUIC stream, …) adapts its
 * per-connection channel to a `RawSocket` and hands it here; the pairing +
 * mutual-authentication handshake and the encrypted `PeerConnection` are
 * identical across transports.
 */
import {
  EnvelopeSchema,
  PreAuthMessageSchema,
  type Envelope,
} from "@bosun/protocol";
import { acceptHello, type Identity, type SessionCrypto } from "./crypto.js";
import type { RawSocket } from "./client-core.js";
import type { PeerConnection, Unsubscribe } from "./types.js";

export interface AcceptOptions {
  identity: Identity;
  isAuthorized(devicePublicKey: string): boolean;
  onPairRequest(
    req: import("@bosun/protocol").PairRequest,
  ): import("@bosun/protocol").PairOk | import("@bosun/protocol").PairError;
  /** Called once the peer is authenticated. */
  onConnection(conn: PeerConnection): void;
}

/**
 * Drive the server handshake on an open raw socket. Handles the optional
 * pairing exchange, then hs.hello → hs.welcome, then upgrades to an
 * authenticated, encrypted PeerConnection.
 */
export function acceptConnection(socket: RawSocket, opts: AcceptOptions): void {
  let session: SessionCrypto | undefined;
  const messageListeners = new Set<(env: Envelope) => void>();
  const closeListeners = new Set<() => void>();

  socket.onClose(() => {
    for (const cb of closeListeners) cb();
  });

  socket.onMessage((data) => {
    if (session) {
      const opened = session.open(data);
      if (opened === null) return; // undecryptable: drop frame
      const parsed = EnvelopeSchema.safeParse(opened);
      if (!parsed.success) return;
      for (const cb of messageListeners) cb(parsed.data);
      return;
    }

    let preAuth;
    try {
      preAuth = PreAuthMessageSchema.parse(JSON.parse(data));
    } catch {
      socket.close();
      return;
    }

    if (preAuth.type === "pair.request") {
      socket.send(JSON.stringify(opts.onPairRequest(preAuth)));
      return; // socket stays open; client follows with hs.hello
    }

    if (preAuth.type === "hs.hello") {
      if (!opts.isAuthorized(preAuth.devicePublicKey)) {
        socket.send(
          JSON.stringify({ type: "hs.reject", message: "device not paired" }),
        );
        socket.close();
        return;
      }
      const accepted = acceptHello(preAuth, opts.identity);
      if (!accepted) {
        socket.send(
          JSON.stringify({ type: "hs.reject", message: "bad signature" }),
        );
        socket.close();
        return;
      }
      session = accepted.session;
      socket.send(JSON.stringify(accepted.message));

      opts.onConnection({
        peerPublicKey: accepted.session.peerPublicKey,
        send: (env) => socket.send(accepted.session.seal(env)),
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
      return;
    }

    // Anything else pre-auth is a protocol violation.
    socket.close();
  });
}
