#!/bin/bash
# Publish the just-packaged build as a GitHub release — the feed electron-updater
# checks (latest-mac.yml is the appcast equivalent; the zip is the update
# artifact, the dmg the first-install artifact, same roles as the Swift app).
# Run AFTER a signed, notarized package:
#
#   CODESIGN_IDENTITY="Developer ID Application: …" NOTARY_PROFILE=canvas-notary Packaging/package.sh
#   Packaging/release.sh
#
# Reads the version straight from the built app (single source of truth) and
# refuses ad-hoc builds — Squirrel.Mac won't install updates over an invalid
# signature, so an unsigned release would strand every installed copy.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="reekko1/agent-canvas"
APP="dist/mac-arm64/Agent Canvas.app"
[ -d "$APP" ] || { echo "✗ $APP not found — run Packaging/package.sh first" >&2; exit 1; }

# Capture first, then grep — piping codesign straight into `grep -q` lets grep
# close the pipe early (SIGPIPE), which under `set -o pipefail` looks like a
# codesign failure and falsely trips the ad-hoc guard.
SIGN_INFO="$(codesign -dvvv "$APP" 2>&1)"
grep -q "Authority=Developer ID" <<< "$SIGN_INFO" || {
    echo "✗ app is ad-hoc signed — repackage with CODESIGN_IDENTITY + NOTARY_PROFILE" >&2
    exit 1
}

VERSION="$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")"
DMG="dist/AgentCanvas-$VERSION.dmg"
ZIP="dist/AgentCanvas-$VERSION.zip"
FEED="dist/latest-mac.yml"
for f in "$DMG" "$ZIP" "$ZIP.blockmap" "$FEED"; do
    [ -f "$f" ] || { echo "✗ $f not found — run Packaging/package.sh first" >&2; exit 1; }
done

if gh release view "v$VERSION" --repo "$REPO" > /dev/null 2>&1; then
    echo "✗ v$VERSION already released — bump the version in package.json and repackage" >&2
    exit 1
fi

# The blockmap enables differential updates (only changed blocks download).
gh release create "v$VERSION" \
    --repo "$REPO" \
    --title "Agent Canvas $VERSION" \
    --generate-notes \
    "$DMG" "$ZIP" "$ZIP.blockmap" "$FEED"

echo "▸ released: https://github.com/$REPO/releases/tag/v$VERSION"
