# Preview release security

The preview pipeline uses GitHub artifact attestations, not Apple credentials or a personal release signing key. The installer authenticates the DMG before mounting it and removes quarantine only from the verified, staged app.

## Trust and channels

The installer trusts `dbuldum4/zsearch` (owner ID `59258696`, repository ID `1410815604`) and `.github/workflows/macos-app.yml`. It verifies GitHub's OIDC issuer and hosted-runner certificate, including numeric identities, workflow URI, source reference, source digest, event and invocation URI. Renaming or transferring a repository does not silently change the pinned trust. Changing the legitimate identities requires a reviewed installer update.

Main builds require `refs/heads/main`, a `push` event and matching app/workflow commits. PR builds require the selected `refs/pull/N/merge` workflow identity and a `pull_request` event. The signed manifest records the actual checked-out PR head commit separately from the merge-workflow commit. The app's `ZSearchCommit` must match the head commit. An authenticated PR build is an experimental preview, not approval of the proposed code.

Both the DMG and the fixed-schema manifest are subjects of the same signed provenance. The installer verifies both subjects and their build invocation. It never sources downloaded metadata, executes a downloaded installer or falls back to an unsigned checksum. Use a trusted checkout for the installer and obtain GitHub CLI through a trusted package manager. Local verifier or installer compromise is outside what download attestation can protect.

## Publication and recovery

Build jobs have read-only credentials and do not receive attestation or publishing authority. The publisher downloads artifacts from its own workflow run, generates the manifest, attests both subjects, verifies the proof and uploads the release. It does not check out or execute project/PR code. Only this job receives `id-token: write`, `attestations: write` and release-write permission. The attestation action and its dependencies are pinned to commits.

Each build has a versioned tag containing its run ID and attempt. The workflow never overwrites a versioned build. The `preview-main` and `preview-pr-N` tags are replaceable aliases; repository administrators can still modify release assets. Authentication detects unproven substitutions, and per-channel local build history rejects replay of previously superseded builds. This is not a freshness guarantee on a first installation or after deleting its state.

Downloads and redirects require HTTPS, have time/size limits, and must authenticate before `hdiutil` runs. The installer checks signatures and app identity after staging, serializes concurrent installs, and leaves the old app intact on copy/verification failures. Rename failures trigger restoration; an unrecoverable backup is retained rather than deleted. Downgrades require `--allow-downgrade` and retain the highest previously accepted build number.

The native CI smoke test installs the exact published build twice with no GitHub token, checks code-signature integrity and verifies quarantine is absent. Shell integration tests exercise tampering, identity mismatch, copy/signature failure, interrupted replacement, failed restore and rollback handling. Provenance demonstrates origin; it does not replace source review, dependency review or runtime protections.

## Settings to enable on GitHub

These account and repository settings require administrative access and are not enabled by a source-code PR:

- Protect the publishing account with passkeys or hardware security keys and securely stored recovery codes.
- Protect `main` against force pushes/deletion; require successful CI and code-owner review for workflow, installer and dependency changes. `.github/CODEOWNERS` names `dbuldum4` for these paths but only enforces review when the branch rule enables it. Choose a review policy that can work for maintainer-authored PRs.
- Limit write/admin collaborators and Actions token defaults; review changes to the trusted workflow before merging.
- If personal release approval is required, use a separately controlled signing key or a protected approval process. A GitHub workflow certificate identifies the repository pipeline, not a human's personal approval.

No Apple Developer ID, notarization or claim of Apple-verified publisher identity is provided by this preview pipeline.
