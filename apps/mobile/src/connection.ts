import {
  PROTOCOL_VERSION,
  QrPayloadSchema,
  type ClientMessage,
  type Envelope,
  type QrPayload,
  type ServerMessage,
} from "@bosun/protocol";
import type { PeerConnection } from "@bosun/transport/client-core";

export function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseQr(data: string): QrPayload | null {
  try {
    return QrPayloadSchema.parse(JSON.parse(data));
  } catch {
    return null;
  }
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
