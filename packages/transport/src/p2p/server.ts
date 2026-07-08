import type { QrPayload } from "@bosun/protocol";
import { acceptConnection } from "../server-core.js";
import type {
  PeerConnection,
  TransportServer,
  TransportServerOptions,
  Unsubscribe,
} from "../types.js";
import { biStreamToRawSocket } from "./framing.js";
import {
  buildEndpoint,
  endpointTicket,
  type IrohEndpoint,
  type RelayConfig,
} from "./endpoint.js";

export interface P2pTransportServerOptions extends TransportServerOptions {
  /** Stable 32-byte iroh secret key → stable dial address across restarts. */
  irohSecretKey?: number[];
  relay?: RelayConfig;
}

/**
 * P2P transport server (iroh). Reuses the exact pairing + authentication
 * handshake and encrypted `PeerConnection` as the LAN transport — iroh only
 * provides the NAT-traversing byte pipe; Bosun's own identity, allowlist, and
 * encryption ride on top unchanged. So one keypair, one allowlist, one
 * protocol across both transports.
 */
export class P2pTransportServer implements TransportServer {
  private endpoint?: IrohEndpoint;
  private ticket?: string;
  private accepting = false;
  private connectionListeners = new Set<(conn: PeerConnection) => void>();
  private readonly relay: RelayConfig;

  constructor(private readonly opts: P2pTransportServerOptions) {
    this.relay = opts.relay ?? { mode: "n0" };
  }

  async start(): Promise<void> {
    this.endpoint = await buildEndpoint({
      relay: this.relay,
      ...(this.opts.irohSecretKey ? { secretKey: this.opts.irohSecretKey } : {}),
    });
    this.ticket = await endpointTicket(this.endpoint);
    this.accepting = true;
    void this.acceptLoop();
  }

  private async acceptLoop(): Promise<void> {
    const ep = this.endpoint;
    if (!ep) return;
    while (this.accepting) {
      let incoming;
      try {
        incoming = await ep.acceptNext();
      } catch {
        break; // endpoint closed
      }
      if (!incoming) break;
      void this.handleIncoming(incoming).catch(() => undefined);
    }
  }

  private async handleIncoming(
    incoming: NonNullable<Awaited<ReturnType<IrohEndpoint["acceptNext"]>>>,
  ): Promise<void> {
    const accepting = await incoming.accept();
    const conn = await accepting.connect();
    const bi = await conn.acceptBi();
    const socket = biStreamToRawSocket(conn, bi);
    acceptConnection(socket, {
      identity: this.opts.identity,
      isAuthorized: this.opts.isAuthorized,
      onPairRequest: this.opts.onPairRequest,
      onConnection: (pc) => {
        for (const cb of this.connectionListeners) cb(pc);
      },
    });
  }

  async stop(): Promise<void> {
    this.accepting = false;
    await this.endpoint?.close();
  }

  /** No routable LAN addresses for a pure P2P server. */
  addresses(): { host: string; port: number }[] {
    return [];
  }

  buildQrPayload(pairingToken: string, expiresAt: number): QrPayload {
    if (!this.ticket) throw new Error("P2P server not started");
    return {
      bosun: 1,
      name: this.opts.name,
      addrs: [],
      supervisorPublicKey: this.opts.identity.publicKey,
      pairingToken,
      expiresAt,
      p2pTicket: this.ticket,
    };
  }

  onConnection(cb: (conn: PeerConnection) => void): Unsubscribe {
    this.connectionListeners.add(cb);
    return () => this.connectionListeners.delete(cb);
  }
}
