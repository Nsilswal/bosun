import type { PairRequest } from "@bosun/protocol";
import { connectClient } from "../client-core.js";
import type { Identity } from "../crypto.js";
import type { PeerConnection } from "../types.js";
import { biStreamToRawSocket } from "./framing.js";
import {
  addrFromTicket,
  buildEndpoint,
  BOSUN_ALPN,
  type RelayConfig,
} from "./endpoint.js";

/**
 * P2P client (iroh). Dials the supervisor by its ticket (node id + hints),
 * then runs the identical Bosun pairing + handshake over the QUIC stream.
 * The Node/CLI path; the mobile app will wrap iroh's Kotlin/Swift bindings
 * behind the same `connectClient` core.
 */
export async function connectP2p(
  ticket: string,
  identity: Identity,
  opts: {
    expectedServerPublicKey?: string;
    pairing?: Omit<PairRequest, "type" | "devicePublicKey">;
    relay?: RelayConfig;
    timeoutMs?: number;
  } = {},
): Promise<PeerConnection> {
  const endpoint = await buildEndpoint({ relay: opts.relay ?? { mode: "n0" } });
  const addr = await addrFromTicket(ticket);
  const conn = await endpoint.connect(addr, BOSUN_ALPN);
  const bi = await conn.openBi();
  const socket = biStreamToRawSocket(conn, bi);
  const peer = await connectClient(socket, identity, {
    ...(opts.expectedServerPublicKey !== undefined
      ? { expectedServerPublicKey: opts.expectedServerPublicKey }
      : {}),
    ...(opts.pairing ? { pairing: opts.pairing } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  // The iroh Endpoint must stay referenced for the connection's whole life:
  // if it's GC'd, its driver future is dropped and the connection dies
  // ("endpoint driver future was dropped"). Capturing it in `close` keeps it
  // reachable as long as the caller holds the peer, and tears it down on close.
  return {
    ...peer,
    close: () => {
      peer.close();
      void endpoint.close();
    },
  };
}
