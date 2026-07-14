#!/usr/bin/env bash
# Fetch iroh 1.0's iOS artifacts into the BosunIroh module so CocoaPods can
# build it. Run once before `expo run:ios` / `expo prebuild` (and again to bump
# IROH_VERSION). Both outputs are gitignored — they're large build artifacts.
#
# Why a script and not a pod `prepare_command`: local Expo modules are
# integrated as `:path` (development) pods, and CocoaPods skips prepare_command
# for those. So we stage the artifacts ahead of pod install instead.
set -euo pipefail

IROH_VERSION="${IROH_VERSION:-v1.0.0}"
MODULE_IOS_DIR="$(cd "$(dirname "$0")/../ios" && pwd)"
ZIP_URL="https://github.com/n0-computer/iroh-ffi/releases/download/${IROH_VERSION}/IrohLib.xcframework.zip"
SWIFT_URL="https://raw.githubusercontent.com/n0-computer/iroh-ffi/${IROH_VERSION}/IrohLib/Sources/IrohLib/IrohLib.swift"

xcframework_dir="${MODULE_IOS_DIR}/Iroh.xcframework"
swift_out="${MODULE_IOS_DIR}/iroh/IrohLib.swift"

echo "▸ iroh ${IROH_VERSION} → ${MODULE_IOS_DIR}"

# 1) Prebuilt Rust FFI xcframework (module `Iroh`). The zip unpacks to
#    Iroh.xcframework at its top level.
if [ -d "${xcframework_dir}" ]; then
  echo "  ✔ Iroh.xcframework already present (delete it to re-fetch)"
else
  tmp="$(mktemp -d)"
  echo "  ↓ ${ZIP_URL}"
  curl -fsSL "${ZIP_URL}" -o "${tmp}/iroh.zip"
  unzip -q "${tmp}/iroh.zip" -d "${tmp}"
  # The archive contains Iroh.xcframework (per iroh-ffi's IrohLibFramework.podspec).
  src="$(find "${tmp}" -maxdepth 2 -name 'Iroh.xcframework' -type d | head -1)"
  if [ -z "${src}" ]; then
    echo "  ✖ Iroh.xcframework not found inside the zip" >&2
    exit 1
  fi
  mv "${src}" "${xcframework_dir}"
  rm -rf "${tmp}"
  echo "  ✔ staged Iroh.xcframework"
fi

# 2) iroh's generated uniffi Swift API (compiled into our pod module).
mkdir -p "${MODULE_IOS_DIR}/iroh"
echo "  ↓ ${SWIFT_URL}"
curl -fsSL "${SWIFT_URL}" -o "${swift_out}"
echo "  ✔ staged iroh/IrohLib.swift"

echo "▸ done. Now run: npx expo run:ios --device"
