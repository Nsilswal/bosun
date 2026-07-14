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

## iroh dependency

iroh 1.0 is **not on CocoaPods** (only 0.20.0 is) — its Swift binding ships as a
prebuilt `IrohLib.xcframework` on the [`v1.0.0` GitHub release](https://github.com/n0-computer/iroh-ffi/releases/tag/v1.0.0),
plus a generated `IrohLib.swift`. So on iOS we **vendor** iroh's own artifacts
(mirroring its `IrohLib` / `IrohLibFramework` podspecs) rather than depend on a
pod. Fetch them before building:

```sh
apps/mobile/modules/bosun-iroh/scripts/fetch-iroh-ios.sh   # → ios/Iroh.xcframework + ios/iroh/IrohLib.swift (gitignored)
```

iroh's xcframework requires **iOS 17.5+**, so the app's deployment target is
bumped to 17.5 via `expo-build-properties` (see `app.json`). Your iPhone must run
iOS 17.5 or newer. Android pulls `computer.iroh:iroh` from Maven Central (see
`android/build.gradle`) — no fetch step.

No extra iOS entitlement: iroh's relay + discovery use outbound HTTPS/QUIC (unlike
LAN mDNS, which needs the multicast entitlement).

## Build (iOS, local device)

Local Expo modules under `apps/mobile/modules/` autolink — no manual linking.
They only compile in a **dev/prebuild** build (never Expo Go). From `apps/mobile`:

```sh
modules/bosun-iroh/scripts/fetch-iroh-ios.sh   # once (and to bump IROH_VERSION)
npx expo run:ios --device                       # prebuild → pod install → build → install
```

If signing fails with a free Apple ID, open `ios/*.xcworkspace` in Xcode once,
set the **BosunApp** target's Signing team to your personal team, then re-run.

## Verification status

Verified in this repo (no device needed):

- ✅ `fetch-iroh-ios.sh` fetches the v1.0.0 xcframework (incl. the `ios-arm64`
  device slice) + `IrohLib.swift`.
- ✅ Every iroh call in the Swift is checked against the **actual generated
  `IrohLib.swift` for v1.0.0** — `EndpointOptions(preset: presetN0(), alpns:
  [Data])` + `Endpoint.bind(options:)`, `endpoint.connect(addr:alpn:)`,
  `openBi()`, `bi.send()/recv()`, `SendStream.writeAll(buf: Data)`,
  `RecvStream.readExact(size: UInt32) -> Data`, `close(errorCode: Int64, reason:
  Data)`, `EndpointTicket.fromString(str:).endpointAddr()`. (The v1.0.0 Swift API
  uses `EndpointOptions`, **not** the napi-style `EndpointBuilder().applyN0()`
  flow — a real difference caught against the artifact.)
- ✅ `expo prebuild -p ios` + `pod install` succeed: `BosunIroh` autolinks, the
  vendored `Iroh.xcframework` embeds, deployment target resolves to 17.5.

- ✅ **iOS on-device build + link + install**: `xcodebuild` for `arm64-apple-ios17.5`
  succeeds — `BosunIrohModule.swift` + iroh's `IrohLib.swift` compile and the app
  **links against the vendored `Iroh.xcframework`** (every iroh symbol resolves),
  producing a `Bosun.app` that installs and runs on an iPhone 17 Pro (iOS 26).

Still to confirm:

1. **Off-Wi-Fi runtime round-trip** (iOS): phone on cellular, supervisor on home
   Wi-Fi — pair, stream the live session, round-trip an escalation over P2P.
   Reference behavior: `packages/transport/scripts/p2p-loopback.ts`.
2. **Android**: the Kotlin mirrors the verified Swift shape; its exact uniffi
   names + build should be confirmed on the first Android build.

Until the runtime round-trip is confirmed, this ships behind the optional-module
fallback: absent the module, the app is unchanged (LAN-only).
