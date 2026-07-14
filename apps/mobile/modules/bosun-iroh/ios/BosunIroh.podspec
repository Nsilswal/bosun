Pod::Spec.new do |s|
  s.name           = 'BosunIroh'
  s.version        = '0.1.0'
  s.summary        = 'iroh QUIC transport for Bosun off-Wi-Fi P2P'
  s.description    = 'Expo native module wrapping iroh 1.0 Swift bindings.'
  s.author         = 'Bosun'
  s.homepage       = 'https://github.com/Nsilswal/bosun'
  s.license        = 'MIT'
  # iroh 1.0's xcframework requires iOS 17.5+ (see iroh-ffi Package.swift). The
  # app's deployment target is bumped to match via expo-build-properties.
  s.platforms      = { :ios => '17.5' }
  s.source         = { :git => '' }
  s.swift_version  = '5.9'
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # iroh 1.0 is NOT on CocoaPods trunk (only 0.20.0 is). Instead of a pod
  # dependency we vendor iroh's own artifacts, replicating its known-good
  # SPM/podspec structure (iroh-ffi's IrohLib + IrohLibFramework):
  #   * Iroh.xcframework      — the prebuilt Rust FFI (module `Iroh`), from the
  #                             v1.0.0 release's IrohLib.xcframework.zip
  #   * iroh/IrohLib.swift    — iroh's generated uniffi Swift API (does
  #                             `import Iroh`)
  # Both are fetched by scripts/fetch-iroh-ios.sh (gitignored — too large / a
  # build artifact) and must exist before `pod install`. Compiling IrohLib.swift
  # into this pod puts the iroh types in our module, so BosunIrohModule.swift
  # references them without an `import IrohLib`.
  s.source_files       = 'BosunIrohModule.swift', 'iroh/*.swift'
  s.vendored_frameworks = 'Iroh.xcframework'
  # Frameworks iroh links against on iOS (from iroh-ffi Package.swift). CoreWLAN
  # is macOS-only, so it's intentionally omitted here.
  s.frameworks = 'SystemConfiguration', 'Network'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
