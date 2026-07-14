Pod::Spec.new do |s|
  s.name           = 'BosunIroh'
  s.version        = '0.1.0'
  s.summary        = 'iroh QUIC transport for Bosun off-Wi-Fi P2P'
  s.description    = 'Expo native module wrapping iroh 1.0 Swift bindings (IrohLib).'
  s.author         = 'Bosun'
  s.homepage       = 'https://github.com/Nsilswal/bosun'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # iroh 1.0 Swift bindings, published to CocoaPods as `IrohLib`. Pin to the
  # 1.x line — the Bosun ALPN (`bosun/1`) tracks iroh's stable 1.0 wire.
  s.dependency 'IrohLib', '~> 1.0'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
