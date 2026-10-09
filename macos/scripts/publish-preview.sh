#!/bin/bash
# Publish dist/zsearch.dmg as a GitHub pre-release (run by .github/workflows/macos-app.yml).
#
#   preview-pr-<n>  for pull request <n>, replaced on every push and deleted when the PR closes
#   preview-main    for the main branch
#
# Environment: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID, SHA, and PR_NUMBER for pull requests.
set -euo pipefail

: "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}" "${SHA:?}"
REPO=$GITHUB_REPOSITORY
SERVER=${GITHUB_SERVER_URL:-https://github.com}
SHORT=${SHA:0:7}
RUN_URL="$SERVER/$REPO/actions/runs/${GITHUB_RUN_ID:-}"

if [ -n "${PR_NUMBER:-}" ]; then
  TAG="preview-pr-$PR_NUMBER"
  TITLE="macOS preview: PR #$PR_NUMBER ($SHORT)"
  ARG=$PR_NUMBER
else
  TAG="preview-main"
  TITLE="macOS preview: main ($SHORT)"
  ARG=main
fi
DMG_URL="$SERVER/$REPO/releases/download/$TAG/zsearch.dmg"

NOTES=$(cat <<NOTES
Preview build of the zsearch Mac app from $SHORT ([build log]($RUN_URL)). It is replaced on every push.

**Install** (from a clone of the repo; downloads with curl, so macOS does not quarantine it):

\`\`\`sh
macos/scripts/install-preview.sh $ARG
\`\`\`

Or download [zsearch.dmg]($DMG_URL) in a browser and drag zsearch to Applications. The app is not notarized, so the first time you open it, go to System Settings › Privacy & Security and choose **Open Anyway**.
NOTES
)

gh release delete "$TAG" --repo "$REPO" --cleanup-tag --yes 2>/dev/null || true
gh release create "$TAG" "dist/zsearch.dmg" --repo "$REPO" --target "$SHA" --prerelease --latest=false --title "$TITLE" --notes "$NOTES"

# Keep one comment on the pull request pointing at the latest build.
if [ -n "${PR_NUMBER:-}" ]; then
  MARKER="<!-- zsearch-macos-preview -->"
  BODY="$MARKER
**macOS preview** for $SHORT: [zsearch.dmg]($DMG_URL) · [release]($SERVER/$REPO/releases/tag/$TAG) · [build log]($RUN_URL)

\`\`\`sh
macos/scripts/install-preview.sh $PR_NUMBER
\`\`\`"
  COMMENT_ID=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | contains(\"$MARKER\"))) | .id" | head -n 1)
  if [ -n "$COMMENT_ID" ]; then
    gh api --method PATCH "repos/$REPO/issues/comments/$COMMENT_ID" -f body="$BODY" >/dev/null
  else
    gh api --method POST "repos/$REPO/issues/$PR_NUMBER/comments" -f body="$BODY" >/dev/null
  fi
fi
echo "Published $TAG: $DMG_URL"
