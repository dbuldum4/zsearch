#!/bin/bash
# Install a GitHub-authenticated preview, without Apple credentials or quarantine.
# Requires a current GitHub CLI (brew install gh); no GitHub login is needed.
# Usage: install-preview.sh <main|PR-number> [--build RUN_ID-ATTEMPT] [--allow-downgrade] [--open]
set -euo pipefail
umask 077

die() { echo "error: $*" >&2; exit 1; }
REPO=dbuldum4/zsearch
OWNER_ID=59258696
REPO_ID=1410815604
[ "${ZSEARCH_REPO:-$REPO}" = "$REPO" ] || die "this installer trusts only $REPO"
DEST=${ZSEARCH_APP_DIR:-$HOME/Applications}
WHICH=${1:-}
case "$WHICH" in
  main) CHANNEL=main; REF=refs/heads/main; EVENT=push ;;
  ''|*[!0-9]*|0*) die "usage: $0 <main|PR-number> [--build RUN_ID-ATTEMPT] [--allow-downgrade] [--open]" ;;
  *) CHANNEL="pr-$WHICH"; REF="refs/pull/$WHICH/merge"; EVENT=pull_request ;;
esac
shift
BUILD=; ALLOW_DOWNGRADE=0; OPEN=0
APP=zsearch.app; APP_ID=io.github.dbuldum4.zsearch; PROCESS=ZSearch
while [ "$#" -gt 0 ]; do
  case "$1" in
    --open) OPEN=1; shift ;;
    --allow-downgrade) ALLOW_DOWNGRADE=1; shift ;;
    --build) [ "$#" -ge 2 ] || die "--build needs RUN_ID-ATTEMPT"; BUILD=$2; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
if [ -n "$BUILD" ]; then
  [[ "$BUILD" =~ ^[1-9][0-9]{0,14}-[1-9][0-9]{0,14}$ ]] || die "invalid build identifier"
fi
[ "$(uname -s)" = Darwin ] || die "the preview installer requires macOS"
command -v gh >/dev/null 2>&1 || die "install the GitHub CLI first: brew install gh"
HELP=$(gh attestation verify --help 2>/dev/null) || die "update GitHub CLI: brew upgrade gh"
for flag in --bundle --cert-identity --source-ref --source-digest --deny-self-hosted-runners --jq; do
  case "$HELP" in *"$flag"*) ;; *) die "update GitHub CLI: brew upgrade gh" ;; esac
done

TMP=$(mktemp -d)
MOUNT="$TMP/mnt"
STAGE=; LOCK=; COMMITTED=0; MOUNTED=0; STATE_WRITTEN=0
cleanup() {
  local status=$1 keep=0
  trap - EXIT HUP INT TERM
  if [ -n "$STAGE" ] && [ "$COMMITTED" = 0 ] && [ -d "$STAGE/previous.app" ]; then
    if [ -e "$DEST/$APP" ] || [ -L "$DEST/$APP" ]; then
      mv "$DEST/$APP" "$STAGE/failed.app" || keep=1
    fi
    if [ "$keep" = 0 ]; then mv "$STAGE/previous.app" "$DEST/$APP" || keep=1; fi
    if [ "$keep" = 1 ]; then
      echo "error: previous app retained at $STAGE/previous.app; restore it manually" >&2
    fi
  fi
  # Keep the build history in step with the app that remains installed.
  if [ -n "$STAGE" ] && [ "$COMMITTED" = 0 ] && [ "$STATE_WRITTEN" = 1 ]; then
    if [ -f "$STAGE/previous.state" ]; then mv "$STAGE/previous.state" "$STATE" || true; else rm -f "$STATE"; fi
  fi
  if [ "$MOUNTED" = 1 ]; then hdiutil detach -quiet "$MOUNT" 2>/dev/null || true; fi
  if [ -n "$STAGE" ] && [ "$keep" = 0 ]; then rm -rf "$STAGE"; fi
  if [ -n "$LOCK" ]; then rmdir "$LOCK" 2>/dev/null || true; fi
  rm -rf "$TMP"
  exit "$status"
}
trap 'cleanup $?' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

download() {
  local tag=$1 name=$2 limit
  case "$name" in preview.manifest) limit=4096 ;; provenance.jsonl) limit=4194304 ;; *) limit=536870912 ;; esac
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fL --silent --show-error \
    --connect-timeout 15 --max-time 600 --max-filesize "$limit" \
    -o "$TMP/$name" "https://github.com/$REPO/releases/download/$tag/$name" ||
    die "could not download authenticated preview $tag ($name)"
  [ "$(wc -c < "$TMP/$name")" -le "$limit" ] || die "download exceeds its size budget ($name)"
}
if [ -z "$BUILD" ]; then
  # The latest alias is replaced on every publish. Read only its (untrusted) build
  # identifier, then fetch every file from that immutable versioned release, so a
  # republish during installation cannot mix files from two builds.
  download "preview-$CHANNEL" preview.manifest
  ALIAS_RUN=; ALIAS_ATTEMPT=
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in run_id=*) ALIAS_RUN=${line#*=} ;; run_attempt=*) ALIAS_ATTEMPT=${line#*=} ;; esac
  done < "$TMP/preview.manifest"
  BUILD="$ALIAS_RUN-$ALIAS_ATTEMPT"
  [[ "$BUILD" =~ ^[1-9][0-9]{0,14}-[1-9][0-9]{0,14}$ ]] || die "could not resolve the latest $CHANNEL preview"
fi
TAG="preview-$CHANNEL-$BUILD"
echo "Downloading $TAG from $REPO"
download "$TAG" preview.manifest
download "$TAG" provenance.jsonl
[ "$(wc -c < "$TMP/preview.manifest")" -le 4096 ] || die "manifest is too large"
[ "$(wc -c < "$TMP/provenance.jsonl")" -le 4194304 ] || die "attestation bundle is too large"

# Only certificate fields authenticated by GitHub OIDC establish account/workflow identity.
# Numeric IDs also prevent a transferred/recreated repository from inheriting this trust.
POLICY='[.[] | .verificationResult.signature.certificate | (.extensions // .) |
  select(.sourceRepositoryIdentifier == "1410815604" and
         .sourceRepositoryOwnerIdentifier == "59258696" and .buildTrigger == "'"$EVENT"'") |
  [.sourceRepositoryDigest, .runInvocationURI] | @tsv] | unique |
  if length == 1 then .[0] else "" end'
verify() {
  local artifact=$1
  shift
  GH_HOST=github.com gh attestation verify "$artifact" --hostname github.com \
    --bundle "$TMP/provenance.jsonl" --repo "$REPO" \
    --cert-identity "https://github.com/$REPO/.github/workflows/macos-app.yml@$REF" \
    --cert-oidc-issuer https://token.actions.githubusercontent.com \
    --source-ref "$REF" --deny-self-hosted-runners \
    --predicate-type https://slsa.dev/provenance/v1 --format json --jq "$POLICY" "$@"
}
PROOF=$(verify "$TMP/preview.manifest") || die "manifest provenance verification failed"
IFS=$'\t' read -r VERIFIED_SHA VERIFIED_RUN EXTRA <<< "$PROOF"
[[ "$VERIFIED_SHA" =~ ^[a-f0-9]{40}$ ]] && [ -z "$EXTRA" ] || die "unexpected publisher certificate"

# Parse a fixed schema after authentication. Never execute or source downloaded metadata.
exec 3< "$TMP/preview.manifest"
field() {
  local line
  IFS= read -r line <&3 || die "missing manifest field $1"
  [ "${line%%=*}" = "$1" ] && [ "$line" != "${line#*=}" ] || die "invalid manifest field $1"
  VALUE=${line#*=}
}
field format; [ "$VALUE" = 1 ] || die "unsupported manifest format"
field repository; [ "$VALUE" = "$REPO" ] || die "wrong repository"
field owner_id; [ "$VALUE" = "$OWNER_ID" ] || die "wrong publisher"
field repository_id; [ "$VALUE" = "$REPO_ID" ] || die "wrong repository identity"
field channel; [ "$VALUE" = "$CHANNEL" ] || die "wrong preview channel"
field source_commit; COMMIT=$VALUE
field workflow_commit; [ "$VALUE" = "$VERIFIED_SHA" ] || die "wrong workflow commit"
field source_ref; [ "$VALUE" = "$REF" ] || die "wrong source reference"
field run_id; RUN_ID=$VALUE
field run_attempt; ATTEMPT=$VALUE
field run_number; NUMBER=$VALUE
field dmg_sha256; DIGEST=$VALUE
EXTRA=
if IFS= read -r EXTRA <&3 || [ -n "$EXTRA" ]; then die "unexpected manifest fields"; fi
exec 3<&-
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] && [[ "$DIGEST" =~ ^[a-f0-9]{64}$ ]] || die "invalid manifest digest"
for n in "$RUN_ID" "$ATTEMPT" "$NUMBER"; do
  [[ "$n" =~ ^[1-9][0-9]{0,14}$ ]] || die "invalid build number"
done
[ "$VERIFIED_RUN" = "https://github.com/$REPO/actions/runs/$RUN_ID/attempts/$ATTEMPT" ] || die "wrong workflow invocation"
[ -z "$BUILD" ] || [ "$BUILD" = "$RUN_ID-$ATTEMPT" ] || die "wrong requested build"
if [ "$CHANNEL" = main ]; then [ "$COMMIT" = "$VERIFIED_SHA" ] || die "main build commit mismatch"; fi

download "$TAG" zsearch.dmg
ACTUAL=$(shasum -a 256 "$TMP/zsearch.dmg" | awk '{print $1}')
[ "$ACTUAL" = "$DIGEST" ] || die "DMG checksum verification failed"
DMG_PROOF=$(verify "$TMP/zsearch.dmg" --source-digest "$VERIFIED_SHA") || die "DMG provenance verification failed"
[ "$DMG_PROOF" = "$PROOF" ] || die "DMG and manifest must belong to the same authenticated build"

# Serialize installs and preserve the highest accepted build for each channel.
mkdir -p "$DEST"
DEST=$(cd "$DEST" && pwd -P)
if mkdir "$DEST/.zsearch-install-lock" 2>/dev/null; then LOCK="$DEST/.zsearch-install-lock";
else die "another installation may be running; if not, remove $DEST/.zsearch-install-lock"; fi
[ ! -L "$DEST/$APP" ] || die "refusing to replace a symlinked app"
STATE_DIR="$DEST/.zsearch-preview-state"
[ ! -L "$STATE_DIR" ] || die "refusing symlinked installation state"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
STATE="$STATE_DIR/$CHANNEL"
OLD_NUMBER=0; OLD_ATTEMPT=0; OLD_DIGEST=
if [ -e "$STATE" ] || [ -L "$STATE" ]; then
  [ -f "$STATE" ] && [ ! -L "$STATE" ] || die "invalid installation state"
  [ "$(wc -c < "$STATE")" -le 200 ] || die "invalid installation state"
  IFS=' ' read -r OLD_NUMBER OLD_ATTEMPT OLD_DIGEST EXTRA < "$STATE" || die "invalid installation state"
  [[ "$OLD_NUMBER" =~ ^[1-9][0-9]{0,14}$ ]] && [[ "$OLD_ATTEMPT" =~ ^[1-9][0-9]{0,14}$ ]] && \
    [[ "$OLD_DIGEST" =~ ^[a-f0-9]{64}$ ]] && [ -z "$EXTRA" ] || die "invalid installation state"
fi
if [ "$NUMBER" -lt "$OLD_NUMBER" ] || { [ "$NUMBER" -eq "$OLD_NUMBER" ] && [ "$ATTEMPT" -lt "$OLD_ATTEMPT" ]; }; then
  [ "$ALLOW_DOWNGRADE" = 1 ] || die "older build blocked; use --allow-downgrade to deliberately install it"
elif [ "$NUMBER" -eq "$OLD_NUMBER" ] && [ "$ATTEMPT" -eq "$OLD_ATTEMPT" ] && [ "$DIGEST" != "$OLD_DIGEST" ]; then
  die "same build number has a different digest"
fi

# Authenticate before mounting; copy and reverify before touching the installed app.
mkdir -p "$MOUNT"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MOUNT" "$TMP/zsearch.dmg"
MOUNTED=1
[ -d "$MOUNT/$APP" ] && [ ! -L "$MOUNT/$APP" ] || die "missing app bundle"
codesign --verify --deep --strict "$MOUNT/$APP"
STAGE=$(mktemp -d "$DEST/.zsearch-stage.XXXXXX")
ditto --noqtn "$MOUNT/$APP" "$STAGE/$APP"
codesign --verify --deep --strict "$STAGE/$APP"
[ "$(plutil -extract ZSearchCommit raw -o - "$STAGE/$APP/Contents/Info.plist")" = "$COMMIT" ] || die "app commit does not match authenticated manifest"
[ "$(plutil -extract CFBundleIdentifier raw -o - "$STAGE/$APP/Contents/Info.plist")" = "$APP_ID" ] || die "wrong app identity"
# The user explicitly chooses no quarantine for these authenticated previews.
# Preserve other extended attributes; verify removal even if an attribute was absent.
xattr -dr com.apple.quarantine "$STAGE/$APP" 2>/dev/null || true
ATTRS=$(xattr -r "$STAGE/$APP") || die "could not inspect app attributes"
case "$ATTRS" in *com.apple.quarantine*) die "could not remove quarantine" ;; esac

if pgrep -xq "$PROCESS"; then
  if ! osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null; then
    die "could not ask ${APP%.app} to quit; quit it and run the installer again"
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -xq "$PROCESS" || break
    sleep 0.5
  done
  if pgrep -xq "$PROCESS"; then die "${APP%.app} is still running; quit it before installing"; fi
fi
if [ -e "$DEST/$APP" ]; then
  [ -d "$DEST/$APP" ] || die "installed app path is not a directory"
  mv "$DEST/$APP" "$STAGE/previous.app"
fi
mv "$STAGE/$APP" "$DEST/$APP"
if [ "$NUMBER" -gt "$OLD_NUMBER" ] || { [ "$NUMBER" -eq "$OLD_NUMBER" ] && [ "$ATTEMPT" -ge "$OLD_ATTEMPT" ]; }; then
  printf '%s %s %s\n' "$NUMBER" "$ATTEMPT" "$DIGEST" > "$STAGE/state"
else
  printf '%s %s %s\n' "$OLD_NUMBER" "$OLD_ATTEMPT" "$OLD_DIGEST" > "$STAGE/state"
fi
if [ -f "$STATE" ]; then cp -p "$STATE" "$STAGE/previous.state"; fi
STATE_WRITTEN=1
mv "$STAGE/state" "$STATE"
COMMITTED=1
echo "Installed authenticated $CHANNEL build $RUN_ID-$ATTEMPT (commit $COMMIT) to $DEST/$APP"
if [ "$OPEN" = 1 ]; then open "$DEST/$APP"; fi
