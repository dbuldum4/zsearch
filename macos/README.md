# zsearch for Mac

A native SwiftUI front end for zsearch. The search engine is the same `zsearch` binary as the terminal app, bundled inside the app and run as `zsearch serve`. The app sends it JSON requests on stdin and reads replies on stdout (see [`src/serve.ts`](../src/serve.ts)). The engine has a single implementation, and the Swift code only draws the UI.

```
zsearch.app/Contents/
  MacOS/ZSearch        the SwiftUI app (this package)
  Helpers/zsearch      the engine (bun run build)
  Helpers/zsearch-ocr  reads text in images and scanned PDFs with Vision (Sources/ZSearchOCR)
  Helpers/zsearch-transcribe  on-device speech transcription with SpeechAnalyzer (macOS 26+)
  Info.plist           from macos/Info.plist
```

## What it does

- **Search** as you type, in names and contents (Find, ⌘1) or forgiving names (Fuzzy, ⌘2). ↑/↓ or ⌘J/⌘K move through results, Return opens, ⇧⌘R shows in Finder, ⇧⌘C copies the path, ⌘L returns to the search field.
- **Filter** with the row under the search field: type, extension, folder, modified date, size and regex. Each control writes the same filter you could type (`type:pdf`, `in:~/Documents`, `re:`…), so the row and the query always agree.
- **Open** with Return, in your code editor with ⌘E (VS Code, Cursor, Zed, Sublime Text, Windsurf, VSCodium or Xcode, at the matching line; pick one in Settings), or in **Quick Look** with Space or ⌘Y. Results show their Finder icons and can be dragged into other apps.
- **Preview** of the selected file with matches highlighted and the first match centered. ⌘G and ⇧⌘G jump to the next and previous match. Previews of the results around the selection are prefetched, so moving through the list doesn't wait on the engine. PDFs show their rendered pages, opened at the page of the match with the matching words highlighted; a Pages/Text switch at the top right of the preview, or "Preview PDFs as" in Settings, shows the extracted text instead. Word documents (`.docx`, `.docm`, `.dotx`) show with their formatting (headings, fonts, lists and tables) on a white page, scrolled to the match with the matching words highlighted; a Document/Text switch, or "Preview Word documents as" in Settings, shows the extracted text instead. Images, video, audio and fonts show as Quick Look shows them; an Image/Text switch shows an image's recognized text instead.
- **Text in images and scans.** `zsearch-ocr` reads images and the PDF pages that have no text with the Vision framework, so a photographed receipt or a scanned letter can be found by its words. A setting turns it off.
- **Speech in recordings.** Supported Macs on macOS 26+ transcribe local audio and video soundtracks with Apple's SpeechAnalyzer. Transcripts are on by default; Settings › Index turns them off and selects the spoken language. Apple may download language assets, but recordings stay on-device. Results show timestamped transcripts, with a File/Transcript switch for playback. Recordings are processed one at a time after documents/images, up to two hours per file with a 30-minute processing deadline; limited transcripts are marked truncated. See [limits and supported formats](../README.md#supported-file-types).
- **Settings** (⌘,): folders to index, what to read (contents, hidden files, .gitignore rules, symbolic links, cloud folders, patterns to skip), how often to update, index size, update and rebuild.
- **Indexing problems** (File › Indexing Problems…, or Problems… in Settings › Index): the files whose contents search cannot find, or finds only in part, by category (could not be read, took too long, transcription failed, too large, no text found, only partly searchable, dataset images, keys and passwords, names-only folders, cloud files), with why in plain words, the reader's own error, size and date. Filter by category, search by path, show in Finder, and read failed files again (one, a selection, or a whole category; keys, names-only and cloud files are never read this way, and the reason names the setting that would change it). "Why Isn't This Searchable?" in a result's context menu, or the toolbar's question mark for any file, explains one file.
- **Menu bar item** with index status and quick actions. While it's on, closing the window keeps zsearch running.
- **Global shortcut** (⌥ Space by default, or ⌃⌥ Space or ⇧⌘ Space, or none) to show or hide zsearch from any app. It opens a floating search panel on the screen with the pointer, which goes away when you open a file, press Esc or click elsewhere; "The shortcut opens" in Settings switches it to the main window. It uses `RegisterEventHotKey`, which needs no accessibility permission.
- **Sorting and exclusions.** Click name, size, date or path to sort; click again for descending order. The result context menu excludes a file/folder, copies all paths, or folds the preview around matches.
- **Live refresh.** Native file events trigger a debounced refresh while the engine runs. ⌘R updates, ⌘. cancels and ⇧⌘I rebuilds. The engine retries one unexpected exit after a short delay.
- **Dock menu** to update or stop indexing, and **open at login**.

## Building without Xcode

The app is built and tested on GitHub Actions ([`.github/workflows/macos-app.yml`](../.github/workflows/macos-app.yml)). You do not need Xcode, or a Mac, to work on it:

| Where | What runs |
| --- | --- |
| Any Linux or Mac with Swift | `swift test --package-path macos`: protocol decoding, line splitting, highlighting. `ZSearchKit` uses only Foundation. |
| GitHub Actions, Linux | the same tests, in the `swift:6.2-noble` container |
| GitHub Actions, macOS | builds the engine, runs the Swift tests against it (`ZSEARCH_ENGINE`), compiles the SwiftUI app, signs it ad hoc, makes `zsearch.dmg` (with `zsearch Semantic.app` next to `zsearch.app`) and publishes it |

Every pull request from this repository gets a GitHub-attested pre-release named `preview-pr-<n>-<run-id>-<attempt>`, plus a comment linking to it. Each push adds a versioned build and replaces the convenient `preview-pr-<n>` alias. The alias and all of the PR's versioned builds are deleted when the PR closes. `main` similarly publishes `preview-main-<run-id>-<attempt>` and a `preview-main` alias, and keeps its newest 10 versioned builds. Pushes to other branches, and pull requests from forks, upload the DMG as a workflow artifact only.

Keep `Sources/ZSearch` (the macOS-only UI) thin and put logic in `Sources/ZSearchKit`, where it can be tested on Linux. The UI files are wrapped in `#if os(macOS)`, so `swift build` also works on Linux (it builds a stub).

## Installing a preview

```sh
brew install gh                            # current GitHub CLI; no login needed
macos/scripts/install-preview.sh 12          # pull request #12
macos/scripts/install-preview.sh main        # latest main
macos/scripts/install-preview.sh main --semantic  # zsearch Semantic.app (Semantic search only)
macos/scripts/install-preview.sh 12 --open
macos/scripts/install-preview.sh main --build 123456789-1  # exact versioned build
```

Run a reviewed copy of the installer from a trusted checkout. It downloads over HTTPS and verifies the signed manifest and DMG with GitHub CLI **before mounting** the image. Verification pins `dbuldum4/zsearch`, the numeric owner and repository IDs, the exact macOS workflow, the main or PR source reference, the workflow commit and the build invocation. A checksum alone, a missing attestation, a wrong publisher or an unrelated workflow is rejected. `ZSEARCH_REPO` cannot redirect this installer to a different publisher.

The script stages and verifies `zsearch.app`, including its source commit, before quitting the running app and replacing the installed copy. It restores the previous copy if replacement fails; if restoration itself fails, it keeps the backup and prints its location. It installs to `~/Applications` without admin rights (`ZSEARCH_APP_DIR` overrides the destination). A private state file there remembers the newest successfully installed build for each channel, so replaying an older authenticated build is rejected. Use `--allow-downgrade` for a deliberate downgrade; this does not lower the remembered highest build. A fresh destination has no previous build history.

**The installer removes `com.apple.quarantine` from the authenticated copy.** It does not use an Apple Developer ID or notarization. Browser downloads and manual copies can still carry quarantine and need **Open Anyway** in System Settings › Privacy & Security. GitHub provenance authenticates the project workflow and exact bytes; it does not establish that the code is harmless or that `dbuldum4` personally reviewed a PR preview.

Older previews without the manifest and attestation bundle cannot be installed through this authenticated path. Without `--build`, the installer reads the build number from the latest alias and downloads every file from that versioned release, so a push that lands during installation cannot mix two builds. See [release security](RELEASE-SECURITY.md) for verification and repository settings.

`Info.plist` records the commit as `ZSearchCommit`:

```sh
/usr/libexec/PlistBuddy -c 'Print :ZSearchCommit' ~/Applications/zsearch.app/Contents/Info.plist
```

## Signing and folder permissions

Builds are signed ad hoc (`codesign --sign -`), not with a Developer ID, and are not notarized. macOS ties folder permissions (Documents, Downloads, Full Disk Access) to the code signature, and an ad hoc signature changes with every build. A new preview may therefore ask again for access to Documents and Downloads, and a Full Disk Access grant must be renewed after each update.

`build-app.sh` supports stable Developer ID signing and notarization. Import your certificate into the build keychain, configure a `notarytool` keychain profile, then run:

```sh
ZSEARCH_RELEASE=1 \
ZSEARCH_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
ZSEARCH_NOTARY_PROFILE="zsearch-notary" macos/scripts/build-app.sh
```

Release mode requires both values, enables the hardened runtime and timestamps, signs inside-out with Bun’s JIT/FFI entitlements, submits the DMG, staples the ticket and verifies Gatekeeper acceptance. This requires an Apple Developer account and a macOS host. Preview CI uses ad-hoc signing with read-only build credentials. A separate publisher authenticates the completed DMG and manifest with GitHub's short-lived signing identity; it never checks out or runs PR code and needs no Apple credentials or long-lived release signing key.

## Running from source on a Mac

If the Command Line Tools are installed (`xcode-select --install`; this is not Xcode), you can run the app without bundling it:

```sh
bun run build
ZSEARCH_ENGINE=$PWD/dist/zsearch swift run --package-path macos ZSearch
```

Only debug builds read `ZSEARCH_ENGINE`; release builds always run the engine inside the app bundle.

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
| `{"id":7,"type":"problems","categories":["unreadable"],"query":"scan","offset":0,"limit":200}` | `problems`: a page of `problems` (path, size, mtime, category, plain-language `reason`, the reader's `detail`, `at`, `retry`, `setting`), the `total`, and counts by category (`categories`, with `query` applied). No `categories`: all of them |
| `{"id":8,"type":"explain","path":"~/Downloads/scan.pdf"}` | `explanation`: whether its contents (`content`), its name only (`name`) or nothing (`none`) is searchable, and why |
| `{"id":9,"type":"retryProblems","paths":["/…"]}` / `{"type":"retryProblems","category":"timeout"}` | `retried` (`retried` count, `refused` with reasons, `reading`: an update starts `now`, follows the running one (`next`), or waits for the process holding the lock (`waiting`); a category a retry cannot help is an `error`) |

Events without an `id`: `ready` (first line: version, `firstRun`, config), `indexProgress`, `indexDone`, `refreshed`, and `error` for unreadable input. Match ranges are `[start, end)` offsets in UTF-16 code units (JavaScript string indices). `highlightRuns` in ZSearchKit converts them. The engine exits when stdin closes.
