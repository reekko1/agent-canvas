#!/bin/bash
# Build a distributable "Agent Canvas.app" (+ dmg + zip) via electron-builder.
# Same conventions as the Swift repo's Packaging/package.sh — output lands in dist/.
#
#   Packaging/package.sh                  # ad-hoc signed (runs fine locally;
#                                         # downloads still hit Gatekeeper)
#   CODESIGN_IDENTITY="Developer ID Application: …" Packaging/package.sh
#                                         # real signing, ready for notarization
#   CODESIGN_IDENTITY="…" NOTARY_PROFILE=canvas-notary Packaging/package.sh
#                                         # + notarize & staple: the full release
#                                         # artifact, double-click clean
#   VERSION=0.3.0 Packaging/package.sh    # override package.json's version
set -euo pipefail
cd "$(dirname "$0")/.."

ARGS=(--mac)
[ -n "${VERSION:-}" ] && ARGS+=("-c.extraMetadata.version=${VERSION}")

if [ -n "${CODESIGN_IDENTITY:-}" ]; then
    # electron-builder wants the bare cert name; accept the full identity string
    # so the invocation stays interchangeable with the Swift repo's.
    ARGS+=("-c.mac.identity=${CODESIGN_IDENTITY#Developer ID Application: }")
else
    # No identity → skip keychain discovery; electron-builder falls back to
    # ad-hoc signing, which arm64 requires to launch at all.
    export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

if [ -n "${NOTARY_PROFILE:-}" ]; then
    if [ -z "${CODESIGN_IDENTITY:-}" ]; then
        echo "✗ NOTARY_PROFILE set but signing is ad-hoc — set CODESIGN_IDENTITY" >&2
        exit 1
    fi
    # Credentials stored once with:
    #   xcrun notarytool store-credentials <profile> --apple-id … --team-id … --password <app-specific>
    export APPLE_KEYCHAIN_PROFILE="$NOTARY_PROFILE"
    ARGS+=("-c.mac.notarize=true")
fi

# Wipe dist/ so artifacts from a previous (differently-versioned) build can't
# linger and get mistaken for this run's output.
echo "▸ cleaning dist/…"
rm -rf dist

echo "▸ building release…"
npm run build

echo "▸ packaging ($([ -n "${CODESIGN_IDENTITY:-}" ] && echo "$CODESIGN_IDENTITY" || echo ad-hoc))…"
npx electron-builder "${ARGS[@]}"

echo "▸ done:"
ls -1 dist/*.dmg dist/*.zip 2>/dev/null | sed 's/^/  /'
