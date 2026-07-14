# `bosun-iroh` — the `BosunIroh` native module

Off-Wi-Fi transport for the Bosun app: a local [Expo module](https://docs.expo.dev/modules/overview/)
that wraps iroh 1.0's official Swift/Kotlin bindings and exposes a NAT-traversing
QUIC byte pipe to JS. It's the last piece needed to reach a supervisor over P2P
**from the phone** (the supervisor + Node client have shipped it since ADR 0001).

Bosun's own pairing, mutual-auth handshake, allowlist, and NaCl encryption all
run in JS on top of the socket this module exposes — identical to the LAN path.
The native side only moves bytes and length-delimits them.

## JS contract (already in the app)

The app consumes this via `src/transport/native-iroh.ts`, which loads it with
`requireOptionalNativeModule("BosunIroh")` — so builds **without** this module
degrade cleanly to LAN-only. The native module registers `Name("BosunIroh")` and
implements exactly:

| JS                         | native |
|----------------------------|--------|
| `connect(ticket): Promise<string>` | build endpoint (n0 preset, ALPN `bosun/1`), dial ticket, `openBi()`, start read loop → resolve a handle |
| `send(handle, data): Promise<void>` | `writeAll` one length-prefixed frame |
| `close(handle): void`      | cancel read loop, close the connection |
| event `onData {handle, data}` | one inbound framed message |
| event `onClose {handle}`   | stream ended/errored |

Framing matches `packages/transport/src/p2p/framing.ts`: a 4-byte little-endian
length prefix + UTF-8 body, one frame per `onData`.

## What this maps to in iroh 1.0

Translated from the verified Node client
(`packages/transport/src/p2p/{client,endpoint,framing}.ts`) to the iroh-ffi
uniffi surface (`EndpointBuilder().applyN0()/alpns()/bind()`,
`endpoint.connect(addr, alpn)`, `connection.openBi()`, `bi.send()/recv()`,
`SendStream.writeAll`, `RecvStream.readExact`, `EndpointTicket.fromString(...)
.endpointAddr()`). The iroh `Endpoint` is retained for the connection's whole
life — releasing it drops iroh's driver future and kills the connection
mid-session (the gotcha encoded in the Node `connectP2p`).

## Build

Local Expo modules under `apps/mobile/modules/` autolink — no `app.json` change.
They only compile in a **dev/prebuild** build (never Expo Go). From `apps/mobile`:

```sh
npx expo run:ios       # or: eas build --profile development --platform ios
npx expo run:android   # or: --platform android
```

Native dependencies (declared here, pulled by CocoaPods / Gradle):

- iOS: `IrohLib` (`~> 1.0`) via CocoaPods — see `ios/BosunIroh.podspec`.
- Android: `computer.iroh:iroh:1.+` from Maven Central — see `android/build.gradle`.

No extra iOS entitlement: iroh's relay + discovery use outbound HTTPS/QUIC (unlike
LAN mDNS, which needs the multicast entitlement).

## ⚠️ Verification status

The native sources are written against iroh-ffi's **documented 1.0 uniffi API**
and the Expo SDK 57 module API, but have **not been compiled on device** — an
iOS/Android native build with the Rust bindings can't run in CI-less dev here.
Before merging into a release, build on device and confirm:

1. **It compiles** against the resolved `IrohLib` / `computer.iroh:iroh` versions.
   The likeliest touch-ups are uniffi byte-type mappings — this code assumes
   `Vec<u8>` ⇄ Swift `Data` / Kotlin `ByteArray` and `u32` ⇄ Swift `UInt32` /
   Kotlin `UInt`. Adjust if the generated bindings differ.
2. **It interoperates** with a supervisor started via `bosun --transport p2p`
   (or the default `both`), reusing `packages/transport/scripts/p2p-loopback.ts`
   as the reference for correct behavior.
3. **Off-Wi-Fi end-to-end**: phone on cellular, supervisor on home Wi-Fi — pair,
   then confirm the live session streams and an escalation round-trips over P2P.

Until then, ship it behind the existing optional-module fallback: absent the
module, the app is unchanged (LAN-only).
