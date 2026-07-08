import os from "node:os";
import { Bonjour, type Service } from "bonjour-service";
import { WebSocketServer, type WebSocket } from "ws";
import {
  EnvelopeSchema,
  PreAuthMessageSchema,
  type Envelope,
  type QrPayload,
} from "@bosun/protocol";
import { acceptHello, type SessionCrypto } from "../crypto.js";
import type {
  PeerConnection,
  TransportServer,
  TransportServerOptions,
  Unsubscribe,
} from "../types.js";

export const MDNS_SERVICE_TYPE = "bosun";

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

export class LanTransportServer implements TransportServer {
  private wss?: WebSocketServer;
  private bonjour?: Bonjour;
  private service?: Service;
  private boundPort = 0;
  private connectionListeners = new Set<(conn: PeerConnection) => void>();

  constructor(private readonly opts: TransportServerOptions) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.opts.port ?? 0 });
      wss.once("listening", () => {
        const addr = wss.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : 0;
        this.wss = wss;
        resolve();
      });
      wss.once("error", reject);
      wss.on("connection", (ws) => this.handleSocket(ws));
    });

    if (this.opts.advertise !== false) {
      this.bonjour = new Bonjour();
      this.service = this.bonjour.publish({
        name: this.opts.name,
        type: MDNS_SERVICE_TYPE,
        port: this.boundPort,
        txt: { pk: this.opts.identity.publicKey },
      });
    }
  }

  async stop(): Promise<void> {
    this.service?.stop?.();
    this.bonjour?.destroy();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      for (const client of this.wss.clients) client.terminate();
      this.wss.close(() => resolve());
    });
  }

  addresses(): { host: string; port: number }[] {
    return lanAddresses().map((host) => ({ host, port: this.boundPort }));
  }

  buildQrPayload(pairingToken: string, expiresAt: number): QrPayload {
    return {
      bosun: 1,
      name: this.opts.name,
      addrs: this.addresses(),
      supervisorPublicKey: this.opts.identity.publicKey,
      pairingToken,
      expiresAt,
    };
  }

  onConnection(cb: (conn: PeerConnection) => void): Unsubscribe {
    this.connectionListeners.add(cb);
    return () => this.connectionListeners.delete(cb);
  }

  private handleSocket(ws: WebSocket): void {
    let session: SessionCrypto | undefined;
    const messageListeners = new Set<(env: Envelope) => void>();
    const closeListeners = new Set<() => void>();

    ws.on("close", () => {
      for (const cb of closeListeners) cb();
    });

    ws.on("message", (raw) => {
      const data = raw.toString();

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
        ws.close();
        return;
      }

      if (preAuth.type === "pair.request") {
        ws.send(JSON.stringify(this.opts.onPairRequest(preAuth)));
        return; // socket stays open; client follows with hs.hello
      }

      if (preAuth.type === "hs.hello") {
        if (!this.opts.isAuthorized(preAuth.devicePublicKey)) {
          ws.send(
            JSON.stringify({ type: "hs.reject", message: "device not paired" }),
          );
          ws.close();
          return;
        }
        const accepted = acceptHello(preAuth, this.opts.identity);
        if (!accepted) {
          ws.send(
            JSON.stringify({ type: "hs.reject", message: "bad signature" }),
          );
          ws.close();
          return;
        }
        session = accepted.session;
        ws.send(JSON.stringify(accepted.message));

        const conn: PeerConnection = {
          peerPublicKey: accepted.session.peerPublicKey,
          send: (env) => {
            if (ws.readyState === ws.OPEN) ws.send(accepted.session.seal(env));
          },
          onMessage: (cb): Unsubscribe => {
            messageListeners.add(cb);
            return () => messageListeners.delete(cb);
          },
          onClose: (cb): Unsubscribe => {
            closeListeners.add(cb);
            return () => closeListeners.delete(cb);
          },
          close: () => ws.close(),
        };
        for (const cb of this.connectionListeners) cb(conn);
        return;
      }

      // Anything else pre-auth is a protocol violation.
      ws.close();
    });
  }
}
