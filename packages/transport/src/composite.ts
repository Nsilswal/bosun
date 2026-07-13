import type { QrPayload } from "@bosun/protocol";
import type {
  PeerConnection,
  TransportServer,
  Unsubscribe,
} from "./types.js";

export interface CompositeChild {
  /** For logging / which transports actually came up. */
  kind: string;
  server: TransportServer;
  /**
   * If true, a `start()` failure is tolerated: the child is dropped and the
   * composite keeps serving on the remaining children. Used for the optional
   * P2P transport, whose native iroh addon may not be present in every build.
   */
  optional?: boolean;
}

export interface CompositeStartResult {
  started: string[];
  failed: { kind: string; error: Error }[];
}

/**
 * Runs several transport servers as one, so a single supervisor is reachable
 * over every path at once — LAN when the phone is home, iroh P2P when it's
 * away — from a single pairing. Connections from any child fan out to the same
 * listeners, and `buildQrPayload` merges the children into ONE QR: LAN `addrs`
 * from the LAN server plus the `p2pTicket` from the P2P server. The app already
 * stores both and falls back LAN→P2P, so one scan covers on- and off-Wi-Fi.
 *
 * Start is resilient: an `optional` child that fails to start (e.g. the iroh
 * native addon isn't installed) is dropped and the rest keep serving. The
 * composite only throws if every child fails.
 */
export class CompositeTransportServer implements TransportServer {
  private readonly connectionListeners = new Set<(c: PeerConnection) => void>();
  private readonly unsubs: Unsubscribe[] = [];
  /** Children that started successfully; only these serve traffic + QR fields. */
  private active: CompositeChild[] = [];

  constructor(private readonly children: readonly CompositeChild[]) {
    if (children.length === 0) {
      throw new Error("CompositeTransportServer needs at least one child");
    }
  }

  /**
   * Start every child. Required children that fail abort the whole start (after
   * rolling back any already-started children); optional children that fail are
   * dropped. Throws only if nothing started. The detailed outcome is available
   * via {@link lastStart}.
   */
  private _lastStart: CompositeStartResult = { started: [], failed: [] };
  get lastStart(): CompositeStartResult {
    return this._lastStart;
  }

  async start(): Promise<void> {
    const started: CompositeChild[] = [];
    const startedKinds: string[] = [];
    const failed: { kind: string; error: Error }[] = [];

    for (const child of this.children) {
      try {
        await child.server.start();
        started.push(child);
        startedKinds.push(child.kind);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!child.optional) {
          // Roll back anything already up so we don't leak listeners/ports.
          await Promise.allSettled(started.map((c) => c.server.stop()));
          throw error;
        }
        failed.push({ kind: child.kind, error });
      }
    }

    if (started.length === 0) {
      throw new Error(
        `no transport could start: ${failed
          .map((f) => `${f.kind}: ${f.error.message}`)
          .join("; ")}`,
      );
    }

    this.active = started;
    for (const child of started) {
      this.unsubs.push(
        child.server.onConnection((conn) => {
          for (const cb of this.connectionListeners) cb(conn);
        }),
      );
    }
    this._lastStart = { started: startedKinds, failed };
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs.splice(0)) unsub();
    await Promise.allSettled(this.active.map((c) => c.server.stop()));
    this.active = [];
  }

  addresses(): { host: string; port: number }[] {
    return this.active.flatMap((c) => c.server.addresses());
  }

  /**
   * One QR for every transport: start from the first child's payload, then fold
   * in each other child — unioning `addrs` and adopting the first `p2pTicket`
   * any child advertises. Shared fields (name, key, token) are identical across
   * children since they share options.
   */
  buildQrPayload(pairingToken: string, expiresAt: number): QrPayload {
    const [first, ...rest] = this.active;
    if (!first) throw new Error("composite transport not started");
    const merged = first.server.buildQrPayload(pairingToken, expiresAt);
    for (const child of rest) {
      const p = child.server.buildQrPayload(pairingToken, expiresAt);
      merged.addrs = dedupeAddrs([...merged.addrs, ...p.addrs]);
      if (merged.p2pTicket === undefined && p.p2pTicket !== undefined) {
        merged.p2pTicket = p.p2pTicket;
      }
    }
    return merged;
  }

  onConnection(cb: (conn: PeerConnection) => void): Unsubscribe {
    this.connectionListeners.add(cb);
    return () => this.connectionListeners.delete(cb);
  }
}

function dedupeAddrs(
  addrs: { host: string; port: number }[],
): { host: string; port: number }[] {
  const seen = new Set<string>();
  const out: { host: string; port: number }[] = [];
  for (const a of addrs) {
    const key = `${a.host}:${a.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}
