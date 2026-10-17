#!/bin/bash
# Build dist/zsearch.app and dist/zsearch.dmg (macOS only).
#
#   bun run build                      # first: the engine at dist/zsearch
#   scripts/build-embed.sh             # and the embedding helper at dist/zsearch-embed (search by meaning)
#   macos/scripts/build-app.sh
#
# Environment: VERSION (default: package.json), BUILD (default: 1), COMMIT (default: git HEAD).
# ZSEARCH_SEMANTIC_APP=1 also builds dist/zsearch Semantic.app, the same app with Semantic as its
# only search mode, and puts both apps in the DMG.
# Preview builds are ad-hoc signed. Releases use Developer ID and notarization (macos/README.md).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIST="$ROOT/dist"
ENGINE="$DIST/zsearch"
VERSION=${VERSION:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json")}
BUILD=${BUILD:-1}
COMMIT=${COMMIT:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)}

[ -x "$ENGINE" ] || { echo "error: $ENGINE not found; run 'bun run build' first" >&2; exit 1; }
EMBED="$DIST/zsearch-embed"
if [ ! -x "$EMBED" ]; then
  if [ "${ZSEARCH_RELEASE:-0}" = "1" ]; then echo "error: $EMBED not found; run scripts/build-embed.sh first" >&2; exit 1; fi
  echo "warning: $EMBED not found (scripts/build-embed.sh builds it); this app will have no search by meaning" >&2
fi

swift build -c release --package-path "$ROOT/macos" --product ZSearch
swift build -c release --package-path "$ROOT/macos" --product zsearch-ocr
swift build -c release --package-path "$ROOT/macos" --product zsearch-transcribe
BIN=$(swift build -c release --package-path "$ROOT/macos" --show-bin-path)

APP="$DIST/zsearch.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources"
cp "$BIN/ZSearch" "$APP/Contents/MacOS/ZSearch"
cp "$ENGINE" "$APP/Contents/Helpers/zsearch"
# The OCR helper sits next to the engine, where the engine looks for it.
cp "$BIN/zsearch-ocr" "$APP/Contents/Helpers/zsearch-ocr"
cp "$BIN/zsearch-transcribe" "$APP/Contents/Helpers/zsearch-transcribe"
# So does the embedding helper (search by meaning). The model is downloaded on request, not bundled.
[ -x "$EMBED" ] && cp "$EMBED" "$APP/Contents/Helpers/zsearch-embed"
# Licences of what the helpers are built from (DigUp, llama.cpp).
cp "$ROOT/THIRD_PARTY_NOTICES.md" "$APP/Contents/Resources/THIRD_PARTY_NOTICES.md"
sed -e "s/@VERSION@/$VERSION/" -e "s/@BUILD@/$BUILD/" -e "s/@COMMIT@/$COMMIT/" "$ROOT/macos/Info.plist" > "$APP/Contents/Info.plist"

# App icon, drawn by a script (no binary assets in the repository).
ICONSET="$DIST/AppIcon.iconset"
rm -rf "$ICONSET"
if swift "$ROOT/macos/scripts/make-icon.swift" "$ICONSET" && iconutil -c icns -o "$APP/Contents/Resources/AppIcon.icns" "$ICONSET"; then
  rm -rf "$ICONSET"
else
  echo "warning: could not make the app icon; continuing without it" >&2
fi
plutil -lint "$APP/Contents/Info.plist"

# Sign inside-out with a stable Developer ID for releases.
IDENTITY=${ZSEARCH_SIGN_IDENTITY:--}
SIGN_FLAGS=(--force)
if [ "$IDENTITY" != "-" ]; then SIGN_FLAGS+=(--options runtime --timestamp); fi
if [ "${ZSEARCH_RELEASE:-0}" = "1" ] && [ "$IDENTITY" = "-" ]; then
  echo "error: release builds require ZSEARCH_SIGN_IDENTITY" >&2; exit 1
fi
# The engine first, then the bundle.
codesign "${SIGN_FLAGS[@]}" --entitlements "$ROOT/macos/engine-entitlements.plist" --sign "$IDENTITY" --identifier io.github.dbuldum4.zsearch.engine "$APP/Contents/Helpers/zsearch"
codesign "${SIGN_FLAGS[@]}" --sign "$IDENTITY" --identifier io.github.dbuldum4.zsearch.ocr "$APP/Contents/Helpers/zsearch-ocr"
codesign "${SIGN_FLAGS[@]}" --sign "$IDENTITY" --identifier io.github.dbuldum4.zsearch.transcribe "$APP/Contents/Helpers/zsearch-transcribe"
if [ -x "$APP/Contents/Helpers/zsearch-embed" ]; then
  codesign "${SIGN_FLAGS[@]}" --sign "$IDENTITY" --identifier io.github.dbuldum4.zsearch.embed "$APP/Contents/Helpers/zsearch-embed"
fi
codesign "${SIGN_FLAGS[@]}" --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP"

# The bundled engine (and helper) must still run after signing.
"$APP/Contents/Helpers/zsearch" --version
[ -x "$APP/Contents/Helpers/zsearch-embed" ] && "$APP/Contents/Helpers/zsearch-embed" --version

# The semantic-only app: the same binaries under another name and identity, so it can sit next to
# the full app. It runs the same engine on the same index; ZSearchSemanticOnly hides the other modes.
SEMANTIC_APP="$DIST/zsearch Semantic.app"
rm -rf "$SEMANTIC_APP"
if [ "${ZSEARCH_SEMANTIC_APP:-0}" = 1 ]; then
  ditto "$APP" "$SEMANTIC_APP"
  mv "$SEMANTIC_APP/Contents/MacOS/ZSearch" "$SEMANTIC_APP/Contents/MacOS/ZSearchSemantic"
  PLIST="$SEMANTIC_APP/Contents/Info.plist"
  plutil -replace CFBundleExecutable -string ZSearchSemantic "$PLIST"
  plutil -replace CFBundleIdentifier -string io.github.dbuldum4.zsearch.semantic "$PLIST"
  plutil -replace CFBundleName -string "zsearch Semantic" "$PLIST"
  plutil -replace CFBundleDisplayName -string "zsearch Semantic" "$PLIST"
  plutil -insert ZSearchSemanticOnly -bool YES "$PLIST"
  plutil -lint "$PLIST"
  codesign "${SIGN_FLAGS[@]}" --sign "$IDENTITY" "$SEMANTIC_APP"
  codesign --verify --strict --verbose=2 "$SEMANTIC_APP"
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
[ -d "$SEMANTIC_APP" ] && cp -R "$SEMANTIC_APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DIST/zsearch.dmg"
hdiutil create -quiet -volname "zsearch $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO "$DIST/zsearch.dmg"
[ -d "$SEMANTIC_APP" ] && echo "Built $SEMANTIC_APP"
echo "Built $APP and $DIST/zsearch.dmg (version $VERSION, build $BUILD, commit $COMMIT)"

if [ "${ZSEARCH_RELEASE:-0}" = "1" ]; then
  : "${ZSEARCH_NOTARY_PROFILE:?release builds require ZSEARCH_NOTARY_PROFILE}"
  xcrun notarytool submit "$DIST/zsearch.dmg" --keychain-profile "$ZSEARCH_NOTARY_PROFILE" --wait
  xcrun stapler staple "$DIST/zsearch.dmg"
  xcrun stapler validate "$DIST/zsearch.dmg"
  spctl --assess --type open --context context:primary-signature "$DIST/zsearch.dmg"
fi
shasum -a 256 "$DIST/zsearch.dmg" > "$DIST/zsearch.dmg.sha256"
