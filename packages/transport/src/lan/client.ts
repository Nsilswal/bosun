import WebSocket from "ws";
import type { PairRequest } from "@bosun/protocol";
import { connectClient, type RawSocket } from "../client-core.js";
import type { Identity } from "../crypto.js";
import type { PeerConnection } from "../types.js";

function wrap(ws: WebSocket): RawSocket {
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onMessage: (cb) => ws.on("message", (raw) => cb(raw.toString())),
    onClose: (cb) => ws.on("close", () => cb()),
  };
}

/**
 * Node client for the LAN transport (tests + future CLI client). The mobile
 * app uses `client-core` directly over React Native's WebSocket instead.
 */
export async function connectLan(
  addr: { host: string; port: number },
  identity: Identity,
  opts: {
    expectedServerPublicKey?: string;
    pairing?: Omit<PairRequest, "type" | "devicePublicKey">;
    timeoutMs?: number;
  } = {},
): Promise<PeerConnection> {
  const ws = new WebSocket(`ws://${addr.host}:${addr.port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return connectClient(wrap(ws), identity, opts);
}
