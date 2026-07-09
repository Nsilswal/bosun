import {
  connectClient,
  type Identity,
  type PeerConnection,
} from "@bosun/transport/client-core";
import type { QrPayload } from "@bosun/protocol";
import type { StoredSupervisor, TransportId } from "../storage";
import { lanTransport } from "./lan";
import { p2pTransport } from "./p2p";
import { orderTransports } from "./select";
import type { ConnectOutcome, MobileTransport } from "./types";
import { openIrohSocket } from "./native-iroh";
import { firstReachableWs } from "./ws-socket";

export { orderTransports } from "./select";
export type { MobileTransport, ConnectOutcome } from "./types";

const ALL_TRANSPORTS: readonly MobileTransport[] = [lanTransport, p2pTransport];

/**
 * Connect to a paired supervisor, trying transports in preference order and
 * falling back on failure. Records which transport won so the next connect
 * tries it first.
 */
export async function connectToSupervisor(
  sup: StoredSupervisor,
  identity: Identity,
  transports: readonly MobileTransport[] = ALL_TRANSPORTS,
): Promise<ConnectOutcome> {
  const order = orderTransports(sup, transports);
  if (order.length === 0) {
    throw new Error(
      "No usable transport: supervisor has no LAN address, and P2P is " +
        "unavailable (no ticket or native module).",
    );
  }
  let lastErr: unknown;
  for (const transport of order) {
    try {
      const conn = await transport.connect(sup, identity);
      return { conn, transport: transport.id };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** First-time pairing from a scanned QR: LAN if it has addresses, else P2P. */
export async function pairWithSupervisor(
  qr: QrPayload,
  identity: Identity,
  deviceName: string,
): Promise<{ supervisor: StoredSupervisor; conn: PeerConnection; transport: TransportId }> {
  const viaLan = qr.addrs.length > 0;
  const transport: TransportId = viaLan ? "lan" : "p2p";
  const socket = viaLan
    ? await firstReachableWs(qr.addrs)
    : await openIrohSocket(qr.p2pTicket ?? "");

  const conn = await connectClient(socket, identity, {
    // Manual pairing may carry no key: trust-on-first-use. QR pairing pins.
    ...(qr.supervisorPublicKey
      ? { expectedServerPublicKey: qr.supervisorPublicKey }
      : {}),
    pairing: { pairingToken: qr.pairingToken, deviceName, platform: "ios" },
  });

  return {
    supervisor: {
      name: qr.name,
      supervisorPublicKey: conn.peerPublicKey, // pin what actually authenticated
      lastAddrs: qr.addrs,
      ...(qr.p2pTicket ? { p2pTicket: qr.p2pTicket } : {}),
      preferredTransport: transport,
    },
    conn,
    transport,
  };
}
