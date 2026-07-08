import os from "node:os";
import { Bonjour, type Service } from "bonjour-service";
import { WebSocketServer, type WebSocket } from "ws";
import type { QrPayload } from "@bosun/protocol";
import type { RawSocket } from "../client-core.js";
import { acceptConnection } from "../server-core.js";
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
    const socket: RawSocket = {
      send: (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      },
      close: () => ws.close(),
      onMessage: (cb) => ws.on("message", (raw) => cb(raw.toString())),
      onClose: (cb) => ws.on("close", () => cb()),
    };
    acceptConnection(socket, {
      identity: this.opts.identity,
      isAuthorized: this.opts.isAuthorized,
      onPairRequest: this.opts.onPairRequest,
      onConnection: (conn) => {
        for (const cb of this.connectionListeners) cb(conn);
      },
    });
  }
}
