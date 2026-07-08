/**
 * Full Bosun stack over the REAL iroh P2P transport, on loopback with relays
 * disabled (direct QUIC). Native addons don't load under vite-node, so this
 * runs as a plain tsx script instead of a vitest test.
 *
 *   pnpm --filter @bosun/transport exec tsx scripts/p2p-loopback.ts
 *
 * Verifies: pairing, mutual-auth handshake, encrypted protocol round-trip,
 * and allowlist rejection — all over QUIC.
 */
import { generateIdentity } from "../src/crypto.js";
import { P2pTransportServer } from "../src/p2p/server.js";
import { connectP2p } from "../src/p2p/client.js";
import type { Envelope, PairRequest } from "@bosun/protocol";
import type { PeerConnection } from "../src/types.js";

const PAIRING_TOKEN = "p2p-token";
let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "✔" : "✖"} ${label}`);
  if (!ok) failures++;
};

function startServer() {
  const identity = generateIdentity();
  const allowlist = new Set<string>();
  const server = new P2pTransportServer({
    identity,
    name: "p2p-supervisor",
    relay: { mode: "disabled" },
    isAuthorized: (pk) => allowlist.has(pk),
    onPairRequest: (req: PairRequest) => {
      if (req.pairingToken !== PAIRING_TOKEN)
        return { type: "pair.error", message: "bad token" };
      allowlist.add(req.devicePublicKey);
      return {
        type: "pair.ok",
        supervisorName: "p2p-supervisor",
        supervisorPublicKey: identity.publicKey,
      };
    },
  });
  return { server, identity, allowlist };
}

const pairing = {
  pairingToken: PAIRING_TOKEN,
  deviceName: "p2p-phone",
  platform: "ios" as const,
};

const { server, identity, allowlist } = startServer();
await server.start();
const ticket = server.buildQrPayload("t", Date.now() + 60_000).p2pTicket!;
console.log("supervisor ticket:", ticket.slice(0, 32) + "…");

// ── paired device connects over QUIC ─────────────────────────────────────
const device = generateIdentity();
const serverSide = new Promise<PeerConnection>((r) => server.onConnection(r));
const conn = await connectP2p(ticket, device, {
  expectedServerPublicKey: identity.publicKey,
  relay: { mode: "disabled" },
  pairing,
  timeoutMs: 20_000,
});
check("device added to allowlist on pairing", allowlist.has(device.publicKey));
check("client authenticated the supervisor key", conn.peerPublicKey === identity.publicKey);

const sConn = await serverSide;
check("server authenticated the device key", sConn.peerPublicKey === device.publicKey);

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([
    p,
    new Promise<undefined>((r) => setTimeout(() => r(undefined), ms)),
  ]);

const gotPing = new Promise<Envelope>((r) => sConn.onMessage(r));
conn.send({ v: 1, id: "1", msg: { type: "ping" } });
const ping = await withTimeout(gotPing, 5000);
check("client→supervisor envelope over QUIC", ping?.msg.type === "ping");

const gotPong = new Promise<Envelope>((r) => conn.onMessage(r));
sConn.send({ v: 1, id: "2", re: "1", msg: { type: "pong" } });
const pong = await withTimeout(gotPong, 5000);
check("supervisor→client reply over QUIC", pong?.msg.type === "pong");
conn.close();

// ── unpaired device is rejected ──────────────────────────────────────────
const stranger = generateIdentity();
let rejected = false;
try {
  await connectP2p(ticket, stranger, {
    expectedServerPublicKey: identity.publicKey,
    relay: { mode: "disabled" },
    timeoutMs: 20_000,
  });
} catch {
  rejected = true;
}
check("unpaired device rejected", rejected);

await server.stop();
console.log(failures === 0 ? "\nP2P loopback: ALL PASS" : `\nP2P loopback: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
