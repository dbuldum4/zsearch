# zsearch for Mac

A native SwiftUI front end for zsearch. The search engine is the same `zsearch` binary as the terminal app, bundled inside the app and run as `zsearch serve`. The app sends it JSON requests on stdin and reads replies on stdout (see [`src/serve.ts`](../src/serve.ts)). The engine has a single implementation, and the Swift code only draws the UI.

```
zsearch.app/Contents/
  MacOS/ZSearch        the SwiftUI app (this package)
  Helpers/zsearch      the engine (bun run build)
  Info.plist           from macos/Info.plist
```

## What it does

- **Search** as you type, in names and contents (Find, ⌘1) or forgiving names (Fuzzy, ⌘2). ↑/↓ or ⌘J/⌘K move through results, Return opens, ⇧⌘R shows in Finder, ⇧⌘C copies the path, ⌘L returns to the search field.
- **Filter** with the row under the search field: type, extension, folder, modified date, size and regex. Each control writes the same filter you could type (`type:pdf`, `in:~/Documents`, `re:`…), so the row and the query always agree.
- **Preview** of the selected file with matches highlighted and the first match centered. Previews of the results around the selection are prefetched, so moving through the list doesn't wait on the engine. PDFs show their rendered pages, opened at the page of the match with the matching words highlighted; a Pages/Text switch at the top right of the preview, or "Preview PDFs as" in Settings, shows the extracted text instead.
- **Settings** (⌘,): folders to index, what to read (contents, hidden files, .gitignore rules, symbolic links, cloud folders, patterns to skip), how often to update, index size, update and rebuild.
- **Menu bar item** with index status and quick actions. While it's on, closing the window keeps zsearch running.
- **Global shortcut** (⌥ Space by default, or ⌃⌥ Space or ⇧⌘ Space, or none) to show or hide zsearch from any app. It uses `RegisterEventHotKey`, which needs no accessibility permission.
- **Dock menu** to update or stop indexing, and **open at login**.

## Building without Xcode

The app is built and tested on GitHub Actions ([`.github/workflows/macos-app.yml`](../.github/workflows/macos-app.yml)). You do not need Xcode, or a Mac, to work on it:

| Where | What runs |
| --- | --- |
| Any Linux or Mac with Swift | `swift test --package-path macos`: protocol decoding, line splitting, highlighting. `ZSearchKit` uses only Foundation. |
| GitHub Actions, Linux | the same tests, in the `swift:6.2-noble` container |
| GitHub Actions, macOS | builds the engine, runs the Swift tests against it (`ZSEARCH_ENGINE`), compiles the SwiftUI app, signs it ad hoc, makes `zsearch.dmg` and publishes it |

Every pull request from this repository gets a pre-release named `preview-pr-<n>`, plus a comment on the PR linking to it. Each push replaces the release, and it is deleted when the PR closes. `main` publishes `preview-main`. Pushes to other branches, and pull requests from forks, upload the DMG as a workflow artifact only.

Keep `Sources/ZSearch` (the macOS-only UI) thin and put logic in `Sources/ZSearchKit`, where it can be tested on Linux. The UI files are wrapped in `#if os(macOS)`, so `swift build` also works on Linux (it builds a stub).

## Installing a preview

```sh
macos/scripts/install-preview.sh 12          # pull request #12
macos/scripts/install-preview.sh main        # latest main
macos/scripts/install-preview.sh 12 --open
```

The script downloads with `curl`, mounts the DMG and copies `zsearch.app` to `~/Applications`, quitting a running copy first. It needs no admin rights. Files fetched with `curl` are not quarantined, so Gatekeeper does not block the app. If you download the DMG in a browser instead, the first launch is blocked: open System Settings › Privacy & Security and click **Open Anyway** (or run `xattr -dr com.apple.quarantine ~/Applications/zsearch.app`).

`Info.plist` records the commit as `ZSearchCommit`:

```sh
/usr/libexec/PlistBuddy -c 'Print :ZSearchCommit' ~/Applications/zsearch.app/Contents/Info.plist
```

## Signing and folder permissions

Builds are signed ad hoc (`codesign --sign -`), not with a Developer ID, and are not notarized. macOS ties folder permissions (Documents, Downloads, Full Disk Access) to the code signature, and an ad hoc signature changes with every build. A new preview may therefore ask again for access to Documents and Downloads, and a Full Disk Access grant must be renewed after each update.

Signing with a Developer ID and notarizing (Apple Developer Program, $99 a year) fixes both problems. That needs these steps in `build-app.sh`, with the certificate and an App Store Connect API key stored as repository secrets:

1. `codesign --options runtime --timestamp --sign "Developer ID Application: …"` instead of `--sign -`. The engine is a Bun executable and needs the JIT entitlements (`com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`) under the hardened runtime.
2. `xcrun notarytool submit dist/zsearch.dmg --wait`, then `xcrun stapler staple dist/zsearch.dmg`.

## Running from source on a Mac

If the Command Line Tools are installed (`xcode-select --install`; this is not Xcode), you can run the app without bundling it:

```sh
bun run build
ZSEARCH_ENGINE=$PWD/dist/zsearch swift run --package-path macos ZSearch
```

`swift build --package-path macos` checks that everything compiles. `swift test` may not work with the Command Line Tools alone (they may not include XCTest); CI runs the tests.

## Protocol

Each line is one JSON object. Requests may carry a numeric `id`, and the reply carries the same `id`. Newer search and preview requests supersede older ones, which reply `{"type":"cancelled"}`.

| Request | Reply |
| --- | --- |
| `{"id":1,"type":"search","query":"budget","mode":"find","limit":200}` | `results` with `response` (hits, strategy, timing) |
| `{"id":2,"type":"preview","file":17,"query":"budget","mode":"find","focusLine":3}` | `preview` with numbered lines and match ranges |
| `{"id":6,"type":"previews","files":[17,18,19],"query":"budget","mode":"find"}` | `previews`: several at once, for prefetching |
| `{"id":3,"type":"stats"}` | `stats` |
| `{"id":4,"type":"config"}` / `{"type":"setConfig","config":{"roots":["~"]}}` | `config` (the fields sent are changed, the rest kept; saved) |
| `{"id":5,"type":"index"}` (`"rebuild":true` to start from empty) / `{"type":"cancelIndex"}` | `ok`, then `indexProgress` events and one `indexDone` |
| `{"type":"opened","path":"/…"}` | `ok` (records the open for ranking) |

Events without an `id`: `ready` (first line: version, `firstRun`, config), `indexProgress`, `indexDone`, `refreshed`, and `error` for unreadable input. Match ranges are `[start, end)` offsets in UTF-16 code units (JavaScript string indices). `highlightRuns` in ZSearchKit converts them. The engine exits when stdin closes.
