# Mobile P2P — the `BosunIroh` native module

The app is already **transport-aware**: it stores a supervisor's `p2pTicket`,
and `orderTransports` / `connectToSupervisor` fall back from LAN to P2P
automatically. The only missing piece for off-Wi-Fi from the phone is a native
module that provides an iroh connection; everything above it (pairing,
handshake, allowlist, encryption, protocol) already runs in JS over the
`RawSocket` the module exposes — identical to the LAN path.

Status: **implemented, pending on-device build verification.** The module lives
at `apps/mobile/modules/bosun-iroh` (Swift + Kotlin, wrapping iroh 1.0's uniffi
bindings); see its [README](../apps/mobile/modules/bosun-iroh/README.md) for the
build steps and the verification checklist. In builds without it (or before it
compiles on device), `requireOptionalNativeModule("BosunIroh")` returns null and
the app runs LAN-only. The JS contract and bridge are done
(`src/transport/native-iroh.ts`).

## What the native module must provide

An Expo module named `BosunIroh` wrapping iroh's official Swift (iOS) and
Kotlin (Android) bindings, exposing:

```
connect(ticket: string): Promise<string>   // dial supervisor; resolve a handle
send(handle: string, data: string): Promise<void>
close(handle: string): void

event onData  { handle: string, data: string }   // one inbound message frame
event onClose { handle: string }
```

Bosun frames messages as UTF-8 strings; the native side should length-delimit
them on the iroh bi-stream (mirror `packages/transport/src/p2p/framing.ts`, a
4-byte LE length prefix) so each `onData` carries exactly one JS message.

### Native connect flow (mirrors the Node client)

1. Build an iroh `Endpoint` with the n0 preset (relays + discovery + crypto
   provider). ALPN = `bosun/1`.
2. Parse the ticket → endpoint address; `connect(addr, alpn)`; `openBi()`.
3. Spawn a read loop delivering framed messages as `onData`.
4. **Retain the `Endpoint` for the connection's lifetime** — the Node client
   hit `endpoint driver future was dropped` when it was released early
   (see ADR 0001). The native side must hold a strong reference until `close`.

## Build & wiring

- Scaffold with `npx create-expo-module@latest --local BosunIroh`, add the iroh
  Swift/Kotlin packages, implement the methods above.
- It autolinks into the existing EAS dev build; no JS changes needed — the
  bridge in `native-iroh.ts` picks it up via `requireOptionalNativeModule`.
- iOS: relay/discovery use outbound HTTPS/QUIC, so no special entitlement is
  required (unlike LAN mDNS browsing, which needs the multicast entitlement).

## Verifying

Reuse the transport's proven loopback logic
(`packages/transport/scripts/p2p-loopback.ts`) as the reference for correct
behavior; the native module should interoperate with a supervisor started via
`bosun --transport p2p`.
