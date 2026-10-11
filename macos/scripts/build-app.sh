#!/bin/bash
# Build dist/zsearch.app and dist/zsearch.dmg (macOS only).
#
#   bun run build                      # first: the engine at dist/zsearch
#   macos/scripts/build-app.sh
#
# Environment: VERSION (default: package.json), BUILD (default: 1), COMMIT (default: git HEAD).
# The app is ad-hoc signed: macOS runs it, but it is not notarized (see macos/README.md).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIST="$ROOT/dist"
ENGINE="$DIST/zsearch"
VERSION=${VERSION:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json")}
BUILD=${BUILD:-1}
COMMIT=${COMMIT:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)}

[ -x "$ENGINE" ] || { echo "error: $ENGINE not found; run 'bun run build' first" >&2; exit 1; }

swift build -c release --package-path "$ROOT/macos" --product ZSearch
swift build -c release --package-path "$ROOT/macos" --product zsearch-ocr
BIN=$(swift build -c release --package-path "$ROOT/macos" --show-bin-path)

APP="$DIST/zsearch.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources"
cp "$BIN/ZSearch" "$APP/Contents/MacOS/ZSearch"
cp "$ENGINE" "$APP/Contents/Helpers/zsearch"
# The OCR helper sits next to the engine, where the engine looks for it.
cp "$BIN/zsearch-ocr" "$APP/Contents/Helpers/zsearch-ocr"
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

# Sign inside-out: the engine first, then the bundle.
codesign --force --sign - --identifier io.github.dbuldum4.zsearch.engine "$APP/Contents/Helpers/zsearch"
codesign --force --sign - --identifier io.github.dbuldum4.zsearch.ocr "$APP/Contents/Helpers/zsearch-ocr"
codesign --force --sign - "$APP"
codesign --verify --strict --verbose=2 "$APP"

# The bundled engine must still run after signing.
"$APP/Contents/Helpers/zsearch" --version

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DIST/zsearch.dmg"
hdiutil create -quiet -volname "zsearch $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO "$DIST/zsearch.dmg"
echo "Built $APP and $DIST/zsearch.dmg (version $VERSION, build $BUILD, commit $COMMIT)"
