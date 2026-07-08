import type { IrohBiStream, IrohConnection } from "./framing.js";

/**
 * The off-Wi-Fi P2P transport, built on iroh 1.0 (QUIC + NAT traversal).
 * See docs/adr/0001-p2p-transport.md for why iroh over libp2p.
 *
 * iroh is an OPTIONAL native dependency (`@number0/iroh`): the LAN transport
 * and the whole supervisor run without it. We therefore load it lazily and
 * describe just the API slice we use with local interfaces, so this package
 * builds and unit-tests whether or not the native addon is installed.
 */

/**
 * Where hole-punch signaling and relay fallback come from. This is the
 * swappable decision the brief left open — it is injected here, never baked
 * into callers.
 *
 *  - `n0`       n0's public relays + discovery. Zero-setup, dev-grade, shared
 *               globally with no uptime guarantees. Relays only see ciphertext.
 *  - `disabled` direct connections only (LAN / loopback / tests).
 *  - `custom`   your own self-hosted relay URLs (iroh relays are open source).
 */
export type RelayConfig =
  | { mode: "n0" }
  | { mode: "disabled" }
  | { mode: "custom"; relayUrls: string[] };

/** Bosun's iroh ALPN. Bump on any wire-incompatible P2P change. */
export const BOSUN_ALPN = Array.from(new TextEncoder().encode("bosun/1"));

// ── minimal structural view of @number0/iroh ────────────────────────────────

interface IrohEndpoint {
  id(): { toString(): string };
  addr(): unknown;
  acceptNext(): Promise<IrohIncoming | null>;
  connect(addr: unknown, alpn: number[]): Promise<IrohConnection & IrohBiOpener>;
  close(): Promise<void>;
}
interface IrohBiOpener {
  openBi(): Promise<IrohBiStream>;
  acceptBi(): Promise<IrohBiStream>;
}
interface IrohIncoming {
  accept(): Promise<IrohAccepting>;
}
interface IrohAccepting {
  connect(): Promise<IrohConnection & IrohBiOpener>;
}
interface IrohBuilder {
  applyN0(): void;
  applyMinimal(): void;
  secretKey(bytes: number[]): void;
  alpns(alpns: number[][]): void;
  relayMode(mode: unknown): void;
  bind(): Promise<IrohEndpoint>;
}
interface IrohModule {
  Endpoint: { builder(): IrohBuilder };
  RelayMode: {
    disabled(): unknown;
    customFromUrls(urls: string[]): unknown;
  };
  EndpointTicket: {
    fromAddr(addr: unknown): { toString(): string };
    fromString(s: string): { endpointAddr(): unknown };
  };
}

let cached: IrohModule | undefined;
async function loadIroh(): Promise<IrohModule> {
  if (cached) return cached;
  try {
    // Non-literal specifier + @vite-ignore: iroh's package.json `main` field
    // trips bundler resolvers, so leave resolution to the Node runtime.
    const spec = "@number0/iroh";
    cached = (await import(/* @vite-ignore */ spec)) as unknown as IrohModule;
    return cached;
  } catch (err) {
    throw new Error(
      "The P2P transport needs the optional '@number0/iroh' native addon. " +
        "Install it (pnpm add @number0/iroh) or use the LAN transport. " +
        `Underlying error: ${String(err)}`,
    );
  }
}

export type { IrohEndpoint, IrohIncoming };

export async function buildEndpoint(opts: {
  /** Stable 32-byte iroh secret key → stable node id (dial address). */
  secretKey?: number[];
  relay: RelayConfig;
}): Promise<IrohEndpoint> {
  const iroh = await loadIroh();
  const b = iroh.Endpoint.builder();
  // A preset must run first — it installs the rustls crypto provider. n0 also
  // wires relays + discovery; minimal is crypto-only (used for direct/tests).
  if (opts.relay.mode === "n0") b.applyN0();
  else b.applyMinimal();
  if (opts.secretKey) b.secretKey(opts.secretKey);
  b.alpns([BOSUN_ALPN]);
  if (opts.relay.mode === "disabled") b.relayMode(iroh.RelayMode.disabled());
  else if (opts.relay.mode === "custom")
    b.relayMode(iroh.RelayMode.customFromUrls(opts.relay.relayUrls));
  return b.bind();
}

/** A shareable dial string (embeds node id + relay/direct hints) for the QR. */
export async function endpointTicket(ep: IrohEndpoint): Promise<string> {
  const iroh = await loadIroh();
  return iroh.EndpointTicket.fromAddr(ep.addr()).toString();
}

/** Resolve a ticket string back into a dial address for `connect`. */
export async function addrFromTicket(ticket: string): Promise<unknown> {
  const iroh = await loadIroh();
  return iroh.EndpointTicket.fromString(ticket).endpointAddr();
}
