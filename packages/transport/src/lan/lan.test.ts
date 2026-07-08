import { afterEach, describe, expect, it } from "vitest";
import type { Envelope, PairRequest } from "@bosun/protocol";
import { generateIdentity } from "../crypto.js";
import type { PeerConnection } from "../types.js";
import { LanTransportServer } from "./server.js";
import { connectLan } from "./client.js";

const PAIRING_TOKEN = "valid-token";

function makeServer() {
  const identity = generateIdentity();
  const allowlist = new Set<string>();
  const server = new LanTransportServer({
    identity,
    name: "test-supervisor",
    isAuthorized: (pk) => allowlist.has(pk),
    onPairRequest: (req: PairRequest) => {
      if (req.pairingToken !== PAIRING_TOKEN) {
        return { type: "pair.error", message: "bad token" };
      }
      allowlist.add(req.devicePublicKey);
      return {
        type: "pair.ok",
        supervisorName: "test-supervisor",
        supervisorPublicKey: identity.publicKey,
      };
    },
    advertise: false,
  });
  return { server, identity, allowlist };
}

const servers: LanTransportServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function started() {
  const s = makeServer();
  await s.server.start();
  servers.push(s.server);
  const port = s.server.buildQrPayload("t", 0).addrs[0]?.port;
  return { ...s, addr: { host: "127.0.0.1", port: port! } };
}

const pairing = {
  pairingToken: PAIRING_TOKEN,
  deviceName: "test-phone",
  platform: "ios" as const,
};

describe("LAN transport end-to-end", () => {
  it("pairs, authenticates, and round-trips envelopes", async () => {
    const { server, identity, addr, allowlist } = await started();
    const device = generateIdentity();

    const serverSide = new Promise<PeerConnection>((resolve) => {
      server.onConnection(resolve);
    });

    const conn = await connectLan(addr, device, {
      expectedServerPublicKey: identity.publicKey,
      pairing,
    });
    expect(allowlist.has(device.publicKey)).toBe(true);
    expect(conn.peerPublicKey).toBe(identity.publicKey);

    const sConn = await serverSide;
    expect(sConn.peerPublicKey).toBe(device.publicKey);

    const gotPing = new Promise<Envelope>((resolve) => {
      sConn.onMessage(resolve);
    });
    conn.send({ v: 1, id: "1", msg: { type: "ping" } });
    expect((await gotPing).msg.type).toBe("ping");

    const gotPong = new Promise<Envelope>((resolve) => {
      conn.onMessage(resolve);
    });
    sConn.send({ v: 1, id: "2", re: "1", msg: { type: "pong" } });
    expect((await gotPong).msg.type).toBe("pong");

    conn.close();
  });

  it("reconnects without pairing once allowlisted", async () => {
    const { identity, addr } = await started();
    const device = generateIdentity();

    const first = await connectLan(addr, device, {
      expectedServerPublicKey: identity.publicKey,
      pairing,
    });
    first.close();

    const again = await connectLan(addr, device, {
      expectedServerPublicKey: identity.publicKey,
    });
    expect(again.peerPublicKey).toBe(identity.publicKey);
    again.close();
  });

  it("rejects unpaired devices", async () => {
    const { identity, addr } = await started();
    const stranger = generateIdentity();
    await expect(
      connectLan(addr, stranger, {
        expectedServerPublicKey: identity.publicKey,
      }),
    ).rejects.toThrow(/not paired/);
  });

  it("rejects a bad pairing token", async () => {
    const { addr } = await started();
    const device = generateIdentity();
    await expect(
      connectLan(addr, device, {
        pairing: { ...pairing, pairingToken: "wrong" },
      }),
    ).rejects.toThrow(/bad token/);
  });

  it("client refuses a server that isn't the pinned key", async () => {
    const { addr } = await started();
    const device = generateIdentity();
    const someOtherKey = generateIdentity().publicKey;
    await expect(
      connectLan(addr, device, {
        expectedServerPublicKey: someOtherKey,
        pairing,
      }),
    ).rejects.toThrow(/failed authentication/);
  });

  it("exposes QR payload with addresses and key", async () => {
    const { server, identity } = await started();
    const qr = server.buildQrPayload("tok", Date.now() + 60_000);
    expect(qr.bosun).toBe(1);
    expect(qr.supervisorPublicKey).toBe(identity.publicKey);
    expect(qr.pairingToken).toBe("tok");
    expect(qr.addrs.length).toBeGreaterThan(0);
  });
});
