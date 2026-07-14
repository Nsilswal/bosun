// The BosunIroh native module is consumed by the app through
// `src/transport/native-iroh.ts`, which loads it via
// `requireOptionalNativeModule("BosunIroh")` so the app degrades to LAN-only in
// builds that don't include it. There is deliberately no JS API surface here —
// this package exists only to carry the native (Swift/Kotlin) sources and let
// Expo autolinking pick them up. See ./README.md for build + verification.
export {};
