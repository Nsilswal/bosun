import { LanTransportServer } from "./lan/server.js";
import { P2pTransportServer } from "./p2p/server.js";
import type { RelayConfig } from "./p2p/endpoint.js";
import type { TransportServer, TransportServerOptions } from "./types.js";
import { CompositeTransportServer } from "./composite.js";

export type TransportKind = "lan" | "p2p";

export interface TransportConfig extends TransportServerOptions {
  kind: TransportKind;
  /** P2P only. Injected here so the relay/signaling choice stays swappable. */
  irohSecretKey?: number[];
  relay?: RelayConfig;
}

/**
 * Build a transport server by kind. Callers depend only on `TransportServer`
 * and never learn whether traffic runs over LAN sockets or iroh QUIC.
 */
export function createTransportServer(cfg: TransportConfig): TransportServer {
  if (cfg.kind === "p2p") {
    return new P2pTransportServer({
      ...cfg,
      ...(cfg.irohSecretKey ? { irohSecretKey: cfg.irohSecretKey } : {}),
      ...(cfg.relay ? { relay: cfg.relay } : {}),
    });
  }
  return new LanTransportServer(cfg);
}

/**
 * Build a composite transport server that serves the given kinds at once, so a
 * single supervisor is reachable both on the LAN and off-Wi-Fi over P2P from
 * one pairing. `p2p` is treated as optional: if its native iroh addon fails to
 * load, that child is dropped and the supervisor still serves the rest (LAN).
 */
export function createTransportServers(
  kinds: readonly TransportKind[],
  cfg: Omit<TransportConfig, "kind">,
): CompositeTransportServer {
  const children = kinds.map((kind) => ({
    kind,
    server: createTransportServer({ ...cfg, kind }),
    optional: kind === "p2p",
  }));
  return new CompositeTransportServer(children);
}
