import {
  PROTOCOL_VERSION,
  QrPayloadSchema,
  type ClientMessage,
  type Envelope,
  type QrPayload,
  type ServerMessage,
} from "@bosun/protocol";
import {
  connectClient,
  type Identity,
  type PairedSupervisor,
  type PeerConnection,
  type RawSocket,
} from "@bosun/transport/client-core";

export function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Open a React Native WebSocket and adapt it to the transport RawSocket. */
function openSocket(addr: { host: string; port: number }): Promise<RawSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${addr.host}:${addr.port}`);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error(`timeout connecting to ${addr.host}:${addr.port}`));
      }
    }, 4000);
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        send: (data) => ws.send(data),
        close: () => ws.close(),
        onMessage: (cb) => {
          ws.onmessage = (ev) => cb(String(ev.data));
        },
        onClose: (cb) => {
          ws.onclose = () => cb();
        },
      });
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`could not reach ${addr.host}:${addr.port}`));
    };
  });
}

async function firstReachable(
  addrs: { host: string; port: number }[],
): Promise<RawSocket> {
  let lastErr: Error = new Error("no addresses to try");
  for (const addr of addrs) {
    try {
      return await openSocket(addr);
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr;
}

export function parseQr(data: string): QrPayload | null {
  try {
    return QrPayloadSchema.parse(JSON.parse(data));
  } catch {
    return null;
  }
}

/** First-time pairing driven by a scanned QR payload. */
export async function pairWithSupervisor(
  qr: QrPayload,
  identity: Identity,
  deviceName: string,
): Promise<{ supervisor: PairedSupervisor; conn: PeerConnection }> {
  const socket = await firstReachable(qr.addrs);
  const conn = await connectClient(socket, identity, {
    // Manual pairing has no key in hand: trust-on-first-use. QR pairing pins.
    ...(qr.supervisorPublicKey
      ? { expectedServerPublicKey: qr.supervisorPublicKey }
      : {}),
    pairing: {
      pairingToken: qr.pairingToken,
      deviceName,
      platform: "ios",
    },
  });
  return {
    supervisor: {
      name: qr.name,
      // Pin whatever key actually authenticated, so TOFU sticks.
      supervisorPublicKey: conn.peerPublicKey,
      lastAddrs: qr.addrs,
    },
    conn,
  };
}

export async function connectToSupervisor(
  sup: PairedSupervisor,
  identity: Identity,
): Promise<PeerConnection> {
  const socket = await firstReachable(sup.lastAddrs);
  return connectClient(socket, identity, {
    expectedServerPublicKey: sup.supervisorPublicKey,
  });
}

/** Request/reply correlation over a PeerConnection. */
export function makeRequester(conn: PeerConnection) {
  return function request(
    msg: ClientMessage,
    timeoutMs = 8000,
  ): Promise<ServerMessage> {
    const id = newId();
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`request ${msg.type} timed out`));
      }, timeoutMs);
      const unsub = conn.onMessage((env: Envelope) => {
        if (env.re === id) {
          clearTimeout(timer);
          unsub();
          resolve(env.msg as ServerMessage);
        }
      });
      conn.send({ v: PROTOCOL_VERSION, id, msg });
    });
  };
}

export function sendMessage(conn: PeerConnection, msg: ClientMessage): void {
  conn.send({ v: PROTOCOL_VERSION, id: newId(), msg });
}
