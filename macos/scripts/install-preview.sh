#!/bin/bash
# Install a preview build of the zsearch Mac app from GitHub releases.
#
#   macos/scripts/install-preview.sh 12          # the build for pull request #12
#   macos/scripts/install-preview.sh main        # the latest build of main
#   macos/scripts/install-preview.sh 12 --open   # and open it
#
# Installs to ~/Applications (no admin rights needed; set ZSEARCH_APP_DIR to change).
# curl does not set the quarantine flag, so Gatekeeper does not block the unsigned app.
set -euo pipefail

REPO=${ZSEARCH_REPO:-dbuldum4/zsearch}
DEST=${ZSEARCH_APP_DIR:-$HOME/Applications}
WHICH=${1:-}
case "$WHICH" in
  main) TAG=preview-main ;;
  '' | *[!0-9]*) echo "usage: $0 <pull-request-number | main> [--open]" >&2; exit 2 ;;
  *) TAG="preview-pr-$WHICH" ;;
esac

TMP=$(mktemp -d)
MOUNT="$TMP/mnt"
cleanup() {
  hdiutil detach -quiet "$MOUNT" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

URL="https://github.com/$REPO/releases/download/$TAG/zsearch.dmg"
echo "Downloading $URL"
if ! curl -fL --progress-bar -o "$TMP/zsearch.dmg" "$URL"; then
  echo "error: no preview build at $TAG (is the build still running, or did it fail?)" >&2
  exit 1
fi

mkdir -p "$MOUNT" "$DEST"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MOUNT" "$TMP/zsearch.dmg"

# Quit a running copy so it can be replaced.
osascript -e 'tell application id "io.github.dbuldum4.zsearch" to quit' >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pgrep -xq ZSearch || break
  sleep 0.5
done

rm -rf "$DEST/zsearch.app"
ditto "$MOUNT/zsearch.app" "$DEST/zsearch.app"
xattr -dr com.apple.quarantine "$DEST/zsearch.app" 2>/dev/null || true

COMMIT=$(/usr/libexec/PlistBuddy -c 'Print :ZSearchCommit' "$DEST/zsearch.app/Contents/Info.plist" 2>/dev/null || echo "?")
echo "Installed $TAG (commit $COMMIT) to $DEST/zsearch.app"
if [ "${2:-}" = "--open" ]; then open "$DEST/zsearch.app"; fi
