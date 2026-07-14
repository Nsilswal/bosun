import { describe, expect, it, vi } from "vitest";
import type { QrPayload } from "@bosun/protocol";
import { CompositeTransportServer } from "./composite.js";
import type { PeerConnection, TransportServer, Unsubscribe } from "./types.js";

/** Minimal fake transport server driven entirely by the test. */
class FakeServer implements TransportServer {
  started = false;
  stopped = false;
  private listeners = new Set<(c: PeerConnection) => void>();
  constructor(
    private readonly opts: {
      addrs?: { host: string; port: number }[];
      p2pTicket?: string;
      startError?: Error;
    } = {},
  ) {}
  async start(): Promise<void> {
    if (this.opts.startError) throw this.opts.startError;
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  addresses(): { host: string; port: number }[] {
    return this.opts.addrs ?? [];
  }
  buildQrPayload(pairingToken: string, expiresAt: number): QrPayload {
    return {
      bosun: 1,
      name: "sup",
      addrs: this.opts.addrs ?? [],
      supervisorPublicKey: "pk",
      pairingToken,
      expiresAt,
      ...(this.opts.p2pTicket ? { p2pTicket: this.opts.p2pTicket } : {}),
    };
  }
  onConnection(cb: (c: PeerConnection) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(conn: PeerConnection): void {
    for (const cb of this.listeners) cb(conn);
  }
}

const fakeConn = (pk: string): PeerConnection => ({
  peerPublicKey: pk,
  send: () => {},
  onMessage: () => () => {},
  onClose: () => () => {},
  close: () => {},
});

describe("CompositeTransportServer", () => {
  it("merges children into one QR: LAN addrs + P2P ticket", async () => {
    const lan = new FakeServer({ addrs: [{ host: "192.168.1.9", port: 45450 }] });
    const p2p = new FakeServer({ p2pTicket: "ticket-abc" });
    const composite = new CompositeTransportServer([
      { kind: "lan", server: lan },
      { kind: "p2p", server: p2p, optional: true },
    ]);
    await composite.start();

    const qr = composite.buildQrPayload("tok", 123);
    expect(qr.addrs).toEqual([{ host: "192.168.1.9", port: 45450 }]);
    expect(qr.p2pTicket).toBe("ticket-abc");
    expect(composite.addresses()).toEqual([
      { host: "192.168.1.9", port: 45450 },
    ]);
  });

  it("fans out connections from every child to one listener set", async () => {
    const lan = new FakeServer();
    const p2p = new FakeServer();
    const composite = new CompositeTransportServer([
      { kind: "lan", server: lan },
      { kind: "p2p", server: p2p },
    ]);
    await composite.start();
    const seen: string[] = [];
    composite.onConnection((c) => seen.push(c.peerPublicKey));

    lan.emit(fakeConn("device-lan"));
    p2p.emit(fakeConn("device-p2p"));
    expect(seen).toEqual(["device-lan", "device-p2p"]);
  });

  it("drops an optional child that fails to start and keeps serving", async () => {
    const lan = new FakeServer({ addrs: [{ host: "10.0.0.2", port: 1 }] });
    const p2p = new FakeServer({ startError: new Error("iroh addon missing") });
    const composite = new CompositeTransportServer([
      { kind: "lan", server: lan },
      { kind: "p2p", server: p2p, optional: true },
    ]);
    await composite.start();

    expect(composite.lastStart.started).toEqual(["lan"]);
    expect(composite.lastStart.failed).toEqual([
      { kind: "p2p", error: expect.any(Error) },
    ]);
    // The failed child contributes nothing to the QR.
    expect(composite.buildQrPayload("t", 1).p2pTicket).toBeUndefined();
  });

  it("throws (rolling back) when a required child fails to start", async () => {
    const lan = new FakeServer();
    const p2p = new FakeServer({ startError: new Error("boom") });
    const composite = new CompositeTransportServer([
      { kind: "lan", server: lan },
      { kind: "p2p", server: p2p }, // not optional
    ]);
    await expect(composite.start()).rejects.toThrow("boom");
    expect(lan.stopped).toBe(true); // already-started child rolled back
  });

  it("throws when no child starts at all", async () => {
    const p2p = new FakeServer({ startError: new Error("iroh addon missing") });
    const composite = new CompositeTransportServer([
      { kind: "p2p", server: p2p, optional: true },
    ]);
    await expect(composite.start()).rejects.toThrow(/no transport could start/);
  });

  it("stops every active child and detaches listeners", async () => {
    const lan = new FakeServer();
    const p2p = new FakeServer();
    const composite = new CompositeTransportServer([
      { kind: "lan", server: lan },
      { kind: "p2p", server: p2p },
    ]);
    await composite.start();
    const cb = vi.fn();
    composite.onConnection(cb);
    await composite.stop();

    expect(lan.stopped).toBe(true);
    expect(p2p.stopped).toBe(true);
    // After stop, child emissions no longer reach listeners (unsubscribed).
    lan.emit(fakeConn("late"));
    expect(cb).not.toHaveBeenCalled();
  });
});
