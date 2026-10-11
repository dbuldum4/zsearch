# Sweep implementation and verification

Implemented on top of PR #10's `599137b` (which includes `main` at `a140a11`). PR #9 and #10 are merged into main; PR #11's CI produces an ad-hoc-signed preview.

The ranked findings have code fixes. Linux behavior is covered by regression tests. Native macOS CI compiles the app, passes real-engine Swift integration and image/PDF Vision OCR fixtures, and builds and verifies the signed DMG. Interactive UI, TCC permissions, Developer ID signing and notarization still require manual Mac verification.

## Ranked findings

| # | Result | Implementation and evidence |
| --- | --- | --- |
| 1 | Fixed | Crawler stat/listing failures protect the affected subtree during deletion cleanup. CLI, MCP and Mac status expose unreadable folders and a permissions hint. Regression removes a genuinely deleted file while preserving a chmod-000 subtree. |
| 2 | Fixed | MCP cannot write `editor`; executable lookup reads PATH without a shell. Terminal editors must resolve to an existing executable; command interpreters are rejected, including symlink aliases. Injection-marker and legitimate `vi +12` regressions pass. |
| 3 | Fixed | File links are skipped by default. Enabled links must remain inside selected roots and pass both alias and canonical target policy, including hidden files, exclusions, ignore rules and names-only restrictions. Stored canonical provenance prevents old content from leaking after a link is repointed. |
| 4 | Fixed | Production extraction jobs have a 60-second deadline; PDFs with OCR receive up to 600 seconds. Exceeding the deadline terminates and replaces the worker and kills tracked helper processes. Cancellation also terminates workers and wakes the waiting index loop. DOC property lengths must move forward within the CLX buffer; corrupt structures cannot fall back to binary strings. XML scanning is linear. ZIP inflation is capped at 16 MiB per entry, 32 MiB total and 2048 parts/read operations, including forged size declarations. Spreadsheet output expansion and compound-file allocations are bounded. Tests cover worker recovery, negative DOC lengths, malformed XML/spreadsheets, archive bombs and cancellation. |
| 5 | Fixed | Folding removes Latin diacritics while retaining non-Latin marks and composed Hangul. Schema version 9 rebuilds older indexes. The supplied Russian, Japanese, Korean, Hindi, Arabic and Thai examples all return hits; Latin café folding still works. |
| 6 | Fixed | Reads, previews, resources and prompts recheck current policy before returning stored text or using a bounded disk fallback. Content-off and names-only files return no text; newly excluded files are inaccessible. MCP paging also revalidates cached hits after ignore-file changes. |
| 7 | Fixed | Grep scans candidates within its time budget, keeps the best matches in a bounded heap, then ranks and limits them. A high-match-count file wins even when newer low-scoring matches would have filled the old limit. Time-limited results remain explicitly partial. |
| 8 | Fixed | Extension, path, folder, size, modification, creation, name and tag filters support negation. Negating result limits or sorting produces a warning. |
| 9 | Fixed | Mixed quoted phrases and words become a literal without quote characters. The supplied phrase-plus-year query has a regression. |
| 10 | Fixed | Regex flags survive parsing and reach search/read matching. Explicit `i` overrides smart case; invalid flags are reported. |
| 11 | Fixed | Keyword snippets use query-derived Latin accent classes rather than folding every character of the document. The ASCII fast path remains; curly quotes no longer trigger whole-document normalization. See the measured snippet check below. |
| 12 | Fixed | Serve reloads configuration before patches, requests and index runs. TUI saves only settings changed from its baseline into the latest configuration. MCP reloads before searches and reads. A serve integration test preserves roots added by another frontend when an app setting changes. |
| 13 | Fixed | Unsupported single-file iWork documents finish as names-only rather than extractor errors. Archives with an embedded Quick Look PDF can be read; image previews use OCR when enabled. Full IWA parsing remains outside this implementation. |
| 14 | Fixed | MCP cannot widen roots or change hidden-file, symlink, ignore, exclusion, cloud, content, editor or live-update policy. `update_index` only uses locally configured roots. Common credential paths never return content. The new `exclude_path` tool only narrows access and requests a refresh. |
| 15 | Fixed | Startup sets umask 077; app-owned config/data directories are 0700 and config/database/journals are 0600. Existing owned paths are tightened. Unrelated database-parent directories are not chmodded. Mode regressions pass. |
| 16 | Implemented; native verification pending | PDF OCR receives a scaled budget, and the Swift helper streams a form-feed-delimited completed page at a time. A terminated helper's complete pages survive; existing PDF text is retained. The stream-recovery behavior is tested with a synthetic helper. Actual Vision OCR speed and long scans require a Mac. |
| 17 | Fixed | Row insertion, metadata updates and content-state changes advance the change sequence. Changed/deleted IDs invalidate their own decoded texts; unrelated cached text survives. Frecency reloads only when its separate sequence changes. |

## Smaller bugs, cleanup and documentation

- PDF deadlines destroy the active pdf.js document; the pool replaces the worker on a PDF parser timeout so unfinished parsing cannot keep it occupied. A synthetic stalled pdf.js document and normal PDF extraction are tested.
- TUI searches clear the spinner when the latest response is cancelled. The Mac app makes one automatic restart attempt after a one-second backoff and retains the manual restart action.
- `.zsearchignore` applies independently of `respectGitignore`; nested roots cannot bypass an ancestor ignore file. Ignore-file events trigger live refreshes even with hidden files disabled.
- CLI, MCP and app setting patches share validation. Invalid modes and out-of-range load settings fail consistently.
- Search catalog refreshes use a consistent database snapshot. Grep checks the generation/config after yielding and before returning; grouped searches also reject results spanning refresh generations.
- Index locks use exclusive kernel `flock` on a stable inode, with no check-then-unlink race and no dependence on a live PID for new locks. Legacy PID locks remain compatible. Linux glibc and Alpine musl acquisition, contention and release were exercised.
- Removed the dead helpers/types named in the report, the impossible Trash path component, and unused internal exports. Progress formatting moved into `util/progress.ts`, so MCP no longer imports the CLI module for it.
- Clock injection replaces the reported load/frecency retry sleeps and tight elapsed-time assertion. MCP cancellation synchronization also avoids the old sleep. Genuine process, watcher and terminal integration tests still use deadlines.
- README and MCP query resources describe reciprocal-rank fusion, mount policy, privacy boundaries, aliases, units, caps and the new controls. The placeholder no longer advertises unsupported `?question`. `ZSEARCH_NO_PDFTOTEXT=0` enables normal tool discovery. Each command has its own help. Fixture dependencies include Pillow; suite duration is described as environment-dependent.
- CI permissions default to read-only. Actions are pinned to commit SHAs; preview publishing is isolated from the job that checks out and executes PR code. The installer checks the DMG checksum and bundle signature and preserves quarantine. Release scripts support hardened-runtime Developer ID signing, notarization, stapling and Gatekeeper verification; preview builds remain ad-hoc signed.

## Requested features and remaining roadmap work

| Request | Delivered |
| --- | --- |
| Name globs | `*.pdf`, `IMG_????`; quoted wildcard text stays literal. |
| Name filter / name-only regex | `name:invoice`, `name:/^IMG_/i`. |
| Sorting | `sort:name`, `sort:size`, `sort:date`, `sort:path`; leading `-` reverses order. CLI `--sort`, TUI cycling and Mac sort buttons. |
| Script output / copy all | `-0`, CSV with quoted cells, and copy-all actions in TUI/Mac. |
| OR and groups | `budget OR invoice`, `(budget OR invoice) type:pdf`; bounded branch counts and time/result budgets. |
| Suggestions | Visible indexed vocabulary supplies “Did you mean” suggestions; protected terms cannot appear. |
| Exclude action | CLI command, TUI shortcut, Mac context menu and narrowing-only MCP tool. Policy hides excluded content immediately; refresh removes stored rows. |
| Duplicates | CLI finder groups by size, then streaming SHA-256, with a deadline and before/after file checks. It obeys content policy and does not modify files. |
| Match / preview controls | `case:`, `word:`, `diacritics:`, ordered `near:`/`NEAR/n`, `created:`, opt-in `tag:`, and `fold:on` previews around matching lines. |
| Live updates | Native recursive filesystem events, including FSEvents on Mac, debounce an incremental index refresh while a frontend runs. Refreshes still walk the selected roots; event-specific path updates remain a future optimization. |
| All words | `all:budget report` finds the words anywhere in a file. Ordinary Find retains literal phrase semantics. |
| Metadata | Opt-in selected EXIF fields, PDF titles and Mac Finder tags, under the same content policy and worker limits. Metadata defaults off. |
| Preserve text on moves | A unique same-filesystem device/inode/size/mtime match retains the row ID and text, updates name/path tokens and moves opening history. Cross-filesystem moves and ambiguous hard links use normal indexing. |
| Notarization | Build support and documented local release commands. Producing and validating a notarized release still requires a Mac, a Developer ID certificate and a configured notary profile. |

Full iWork IWA parsing, path-specific event refreshes and a notarized release are not claimed complete. The supplied probes, `roadmap/next-steps.md` and earlier review files were not present in this checkout; new regressions cover the reported cases instead. Million-file first-keystroke benchmarks and the README's historical benchmark figures were not remeasured.

## Verification

- Bun 1.4.2: TypeScript checks with unused-local/parameter checks and the Linux binary build pass.
- Complete Bun suite with pyte and both source/binary terminal tests: 217 passed, 2 skipped, 0 failed across 15 files (79.53 seconds). The two skips require the real Mac OCR helper.
- Swift 6.2 on Linux: 29 tests pass, including the real bundled-engine protocol integration. Linux compiles the UI/OCR stubs; this does not validate AppKit, SwiftUI, PDFKit or Vision code.
- Native macOS CI: full Bun tests pass, 29 Swift tests pass with the real engine, the app/DMG build and signature verification pass, and all seven OCR tests pass, including a real image and scanned PDF.
- Alpine Bun 1.4.2: kernel-lock acquisition, second-acquisition rejection, holder detection and release pass.
- Workflow YAML, shell syntax and `git diff --check` pass. CI preview publication passes; Apple's Developer ID and notarization services were not invoked.
- Snippet microbenchmark: seven runs per sample, 50,000 matching lines. A 2,150,000-character ASCII sample had a 14.1 ms median; the 2,250,000-character curly-quote sample had an 11.6 ms median on this host. This measures snippet matching, not end-to-end search or million-file latency.
- The mandated independent security review was completed once. Its additional editor lookup, repointed-alias, cached paging, nested-root ignore, counts/suggestions/metadata privacy, read-regex watchdog, XML whitespace/spreadsheet, pdf.js cancellation and musl compatibility findings were addressed with focused checks.
- CI follow-up fixes cover explicitly selected macOS root aliases, duplicate unreadable subtree reports, Bash 3.2 signing arrays and short watchdog deadlines. Policy compilation and directory ignore parsing are shared within each synchronous search stage, then discarded between requests, after asynchronous yields and before returning results. Fresh ignore-file changes are tested in Find, Fuzzy and cached MCP pages. Text extraction avoids a redundant policy check when metadata is disabled.

Security invariants are enforced in shared policy code: a remote assistant cannot select broader index inputs or an editor command; links cannot escape root/target exclusions; current content restrictions apply to stored text as well as disk reads; extraction work has bounded input/output and archive expansion plus a terminable worker deadline. These controls do not provide a separate OS memory quota per worker. Native permission prompts and signed-release behavior remain platform verification limits.

Schema version 9 rebuilds an older index on opening. Configuration is preserved; the next index run repopulates searchable rows. Native watchers require a running frontend, and their periodic scan remains the fallback for missed or unavailable watches.
