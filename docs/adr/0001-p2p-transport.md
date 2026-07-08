# ADR 0001 — Off-Wi-Fi P2P transport: iroh over libp2p

Status: accepted (2026-07-08)

## Context

Slice 2 needs the app to reach the supervisor when they're not on the same
LAN, over a direct, encrypted, peer-to-peer path (agent traffic must touch no
server after the handshake), with a relay fallback for the ~10–20% of networks
where hole-punching fails. The brief left three things to decide: the library
(iroh vs libp2p), whose signaling/bootstrap infra to use, and whether to ship a
relay fallback. The transport interface (`TransportServer` / `PeerConnection`)
was already designed so this choice doesn't leak into callers.

## Decision

**Use [iroh](https://iroh.computer) (Rust core, official Node.js + Swift/Kotlin
bindings).** Bosun keeps its own identity, pairing, allowlist, and NaCl
encryption; iroh only provides the NAT-traversing byte pipe, and the existing
handshake + protocol ride on top of an iroh QUIC bi-stream unchanged. One
keypair, one allowlist, one protocol across both transports.

### Why not js-libp2p

Verified against current docs (July 2026): js-libp2p's hole-punching is still
unreliable — its own materials say the project "has not put significant effort
into hole punching," that it "requires QUIC for reliability and Node.js support
is still missing," and that non-unilateral DCUtR hole-punching "has remained
elusive." For a tool whose entire value is reaching a home machine from a phone
on cellular, that's disqualifying.

### Why iroh

- **iroh 1.0 shipped 2026-06-15** with a stable wire protocol and official
  Node.js (napi), Swift, and Kotlin bindings — covering the Node supervisor and
  (via a React Native native module) the mobile app.
- ~90% direct QUIC hole-punch success; **encrypted relay fallback** when direct
  fails, and relays only ever see ciphertext.
- "Dial keys, not IPs": an endpoint's address *is* a public key — the same
  mental model as our Ed25519 device identity, and it makes the QR ticket a
  stable dial address that survives IP changes (the gap we hit with LAN mDNS).

## Signaling / bootstrap / relay (the brief's open TODO)

Made **swappable via injected config**, never baked into callers
(`RelayConfig` on the transport, `--relay` on the CLI):

- **`n0`** (default): n0's public relays + discovery. Zero-setup, dev-grade,
  shared globally, no uptime guarantees. Fine to start.
- **`disabled`**: direct only (LAN / loopback / tests).
- **`custom`**: your own self-hosted relay URLs. iroh's relay server is open
  source with binary releases, so a privacy- or reliability-sensitive user can
  run their own. This is the recommended production posture for a self-hosted
  tool and keeps us off shared third-party infra.

We ship the relay fallback (it's built into iroh); we do **not** run any Bosun
relay infrastructure. Docs point self-hosters at iroh's relay binary.

## Consequences

- `@number0/iroh` is an **optional** native dependency: the LAN transport and
  the whole supervisor run without it. It's loaded lazily; a missing addon
  degrades to a clear error only on the P2P path.
- The mobile app needs a React Native native module wrapping iroh's
  Swift/Kotlin bindings, behind the existing `connectClient` core. That native
  glue is the main remaining P2P work; the Node supervisor + Node client are
  done and tested (`scripts/p2p-loopback.ts`).
- **Gotcha, learned the hard way and encoded in `connectP2p`:** the iroh
  `Endpoint` must stay referenced for the whole connection lifetime. If it's
  GC'd, its driver future is dropped and the connection dies mid-session
  (`endpoint driver future was dropped`) — the handshake succeeds but the first
  later message vanishes. We retain it by capturing it in the connection's
  `close` closure.

## Verification

`scripts/p2p-loopback.ts` runs the full Bosun stack (pairing, mutual-auth
handshake, encrypted protocol round-trip both directions, allowlist rejection)
over real iroh QUIC on loopback with relays disabled. Cross-NAT verification
with real relays is pending real-network testing.
