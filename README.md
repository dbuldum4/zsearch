# zsearch

Fast search for everything in your files, in the terminal. zsearch indexes your Documents and Downloads folders (or your whole home folder, or the whole disk), reads the text **inside** your files (PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, email, notebooks, code, Markdown and plain text) and lets you find things by name, by exact text or by regular expression. Type a query and results show up as you type.

```
╭─ zsearch ────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ ❯ budget                                                                                   3 results · 6.3ms │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
  FIND   fuzzy                                                         exact text (indexed) · 3 of 3 files read
 XLS  budget.xlsx  Documents                            │ DOC  ~/Documents/report.docx
      sheet 1  Budget 2024                              │ 37 KB · modified 2026-10-08 20:12 (just now) · 1 matc…
▌DOC  report.docx  Documents                            │───────────────────────────────────────────────────────
      L2  The marketing budget for the northern region …│  1 │ Quarterly Planning Report
 PPT  deck.pptx  Documents                              │  2 ▶ The marketing budget for the northern region
      slide 3  Ask about the budget                     │    │ increased by twelve percent.
                                                        │  3 │ Revenue projections look strong for the café
                                                        │    │ expansion.
 26 files · 11 folders · 23 with text (2.8 KB) · indexed just now
 ↵ open  ^E edit  ^O reveal  ^Y copy  ⇥ mode  ^T preview  ^R reindex  ^S settings  F1 help  esc quit
```

The interface is built with [OpenTUI](https://github.com/anomalyco/opentui) and Solid, the same stack as [OpenCode](https://github.com/anomalyco/opencode). It runs on macOS and Linux.

## Highlights

- **Search modes, no guessing.** *Find* (the default) looks for the exact text you type in file names and contents; wrap the query in slashes (`/\d{4}-\d{2}/`) for a regular expression. *Fuzzy* is fzf-style name matching that forgives typos. *Semantic*, if you turn it on, finds files by what they are about. Press <kbd>Tab</kbd> to switch.
- **It looks inside files.** It reads PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP, RTF, EPUB, EML, Jupyter notebooks, legacy `.doc`, `.xls` and `.ppt`, source code, Markdown, HTML, CSV, JSON, logs and other text. It shows which page, slide, sheet or line matched.
- **Setup is guided.** On first launch, zsearch asks what to index (Documents and Downloads, home folder, whole disk or chosen folders) and whether to read file contents or include hidden files. Indexing runs in the background with a progress bar, and results appear while it runs.
- **Updates are incremental.** Only new or changed files are read again, and search picks up the changes without reloading the whole index. While a frontend is running, native file-system events trigger a refresh; an hourly refresh also catches missed events. Press <kbd>Ctrl-R</kbd> to refresh now. Refreshes currently walk the selected roots.
- **Defaults keep the index clean.** zsearch follows `.gitignore`. It skips `node_modules`, VCS folders, caches, trash and package-manager stores, and its own data. On macOS it treats app bundles as single files. It never reads cloud "online-only" placeholders, because reading them would download them. Hidden files are left out unless you turn them on.
- **It is fast and small.** On the benchmark corpus (`bun run bench`: 20,000 files, 80 MB), a full index takes about 14 s and makes a 70 MB index. Find takes 5–20 ms, fuzzy name search about 15–25 ms, and a regex that reads every file about 15–55 ms. Search runs in a worker thread, so typing never stutters.
- **Everything stays local.** The index is a SQLite file on your machine, and zsearch makes no network requests, except to download the model for semantic search when you ask for it.
- **AI assistants can use it.** `zsearch mcp` lets Claude and other MCP clients search your files and read their text (see [below](#use-it-from-claude-and-other-ai-apps-mcp)).

## Install

zsearch needs [Bun](https://bun.sh) 1.3 or newer.

```sh
git clone https://github.com/dbuldum4/zsearch && cd zsearch
bun install
bun link            # puts `zsearch` on your PATH (or run: bun src/main.ts)
```

To build a standalone binary that does not need Bun at runtime:

```sh
bun run build                 # → dist/zsearch for this machine
bun run build --all           # macOS + Linux, x64 + arm64 (run `bun install --os="*" --cpu="*"` first)
cp dist/zsearch ~/.local/bin/
```

Optional: install `pdftotext` (`brew install poppler` / `apt install poppler-utils`) for faster PDF indexing. Without it, zsearch uses its built-in PDF reader.

### Mac app (preview)

There is also a native Mac app (SwiftUI, macOS 14 or newer, Apple silicon) with the same engine inside. It has a settings pane (folders, what to read, automatic updates, index size and rebuild), a menu bar item, and a shortcut (⌥ Space by default) that opens a floating search panel over any app. Space shows the selected file in Quick Look, ⌘E opens it in your code editor, and results can be dragged into other apps. The Mac app also reads the text in images and scanned PDFs, using macOS's own text recognition. Every pull request and every push to `main` builds a DMG on GitHub Actions and publishes it as a pre-release. To install one from a clone:

```sh
macos/scripts/install-preview.sh main       # latest main
macos/scripts/install-preview.sh 12         # pull request #12
macos/scripts/install-preview.sh main --semantic   # zsearch Semantic.app: Semantic search only
```

Each DMG also holds **zsearch Semantic.app**, the same app with Semantic as its only search mode (no Find or Fuzzy). Mode prefixes and `/regex/` are read as words to search by meaning. It runs the same engine on the same index as zsearch.app, so the two can be installed side by side, and it downloads the semantic models when it starts.

Install a current GitHub CLI first (`brew install gh`). The preview installer verifies GitHub provenance before mounting the download, stages a recoverable replacement, and installs without a quarantine marker. No GitHub login or Apple credentials are required. See [Mac installation and verification](macos/README.md#installing-a-preview).

See [macos/README.md](macos/README.md) for how it is built and how to work on it without Xcode.

## Quick start

```sh
zsearch                 # first run: choose what to index, then search
zsearch invoice 2024    # open with a query
zsearch -p              # pick a file and print its path:  vim "$(zsearch -p)"
```

Type to search. Use <kbd>↑</kbd>/<kbd>↓</kbd> to move, <kbd>Enter</kbd> to open the file in its default app, and <kbd>Ctrl-E</kbd> to open it in `$EDITOR` at the matching line. Press <kbd>F1</kbd> to see every key.

## Search modes

| Mode | What it does | Good for |
| --- | --- | --- |
| **find** (default) | The exact text you type, in file contents and paths. Several words are one piece of text, in that order (`marketing budget`). It is smart-case: case-sensitive only if the query has a capital letter. `"Quotes"` around the whole query are optional. | Almost everything: names, phrases, error messages, IDs |
| **find** with `/regex/` | Wrap the query in slashes, or start it with `re:`, and it runs as a JavaScript regular expression over contents and paths. Nothing else is ever treated as a regex. | Code, dates, emails, structured text |
| **semantic** (optional) | Files about what you describe, in other words than theirs: `lease for the flat in Lisbon`, `screenshot of a flight booking`. It needs a model downloaded first; see [Semantic search](#semantic-search). | Things you remember the gist of, not the words |
| **fuzzy** | Matches file paths the way fzf does: subsequences, with bonuses for word starts, `camelCase`, path separators and runs of consecutive letters, and a preference for the file name over the folders. Typos are forgiven (`mian` finds `main.rs`, `recieve` finds `receive.py`). Content matches are typo-tolerant too. Supports fzf operators: `'exact` `^prefix` `suffix$` `!exclude`. | Finding a file whose name you half remember |

Find narrows the candidates through the index first (the literal parts of a regex too), so most searches don't have to read every file. It ranks an oversampled pool of content matches by match count, then combines them with name matches using reciprocal-rank fusion. Opening history and modification time break near ties; a name match is not guaranteed to come first. Ranking happens before the result limit. Broad queries stop after five times the requested matches (at least 100) or their time budget and are marked partial; explicit sorting scans until completion or its time budget. `f:…` runs one query in fuzzy mode, `s:…` in semantic mode.

### Semantic search

Semantic search runs two models on your computer, and ranks results together with your words the way [DigUp](https://github.com/ARahim3/DigUp) does:

- [potion-retrieval-32M](https://huggingface.co/minishlab/potion-retrieval-32M) (Minish Lab, MIT), a [Model2Vec](https://github.com/MinishLab/model2vec) static model: a passage's vector is the average of its word pieces' vectors, so it reads every file within moments of an index update.
- IBM's [granite-embedding-small-english-r2](https://huggingface.co/ibm-granite/granite-embedding-small-english-r2) (Apache 2.0), a 47M-parameter encoder run with [llama.cpp](https://github.com/ggml-org/llama.cpp), which reads the files again in the background. A file is searched with Granite's vectors once Granite has read it, and with Potion's until then.

The Mac app downloads both when it starts (131 MB and 52 MB), unless you turned semantic search off; find and fuzzy never need them. In the terminal:

```sh
zsearch semantic install      # downloads both models, checks their checksums
zsearch index                 # reads your files for meaning (any index update does, from now on)
zsearch search -m semantic 'notes from the meeting about the office move'
zsearch semantic status       # what has been read; `zsearch semantic remove` deletes the models and their indexes
```

In the Mac app it is **Settings › Semantic**, and the **Semantic** tab next to Find and Fuzzy. The terminal app's third tab is **semantic** (<kbd>Tab</kbd> or <kbd>Alt-3</kbd>).

Every passage of every file is scored against the query, and the scores are put on one scale per query and model: how far a passage stands out from the rest of that model's passages. A file is a result if its best passage stands out clearly, or if it holds at least half of the query's words; it scores its meaning plus a bonus for the words it holds, plus one for the kind of file the query asks for ("…pdf", "slides…"). A query of codes and numbers (`INV-2024-118`) weighs words double. The preview opens at the passage that matched.

Until Granite has read every file, meaning doesn't weigh against words: a static model like Potion too often finds a long manual or an unrelated note as close as the file the words point at, and while Granite is part way the files it has read would be scored on meaning and the rest on words alone. So the files holding the query's words rank as they would without any model, meaning only orders the ones the words can't tell apart, and the files found by meaning alone come after them. Once Granite has read everything, the files holding every word still come first, ordered by meaning, and meaning weighs against words among the rest. Either way, a file named for the query (`SHS Handbook.pdf`) comes before one that only mentions it, and a long file's best passage counts for a little less, since the best of hundreds stands out by chance. Lean proofs (`.lean`) are left to find and fuzzy: they are neither read for meaning nor shown in the semantic tab.

`scripts/semantic-eval.ts` measures this on a home folder of 49 notes and letters and 210 package READMEs and licences, with 36 questions. With Potion, words and meaning now rank 1 question below words alone (by ordering a tie differently) and 8 above it. Before, 7 ranked below.

Reading files for meaning is the slow part, so zsearch does much less of it than DigUp does for the same results:

- It embeds the text the index already extracted, rather than reading every file again.
- Passages from many files go to the model together, sorted by length and packed into as few model calls as fit; the next batch is prepared while one runs.
- A passage is embedded once wherever it appears: copies of a file (`report (1).pdf`), text shared between files, and files that were renamed, moved or re-indexed from scratch cost nothing more. An edited file only has its edited passages embedded again, because passages end where the text says (at paragraphs a hash picks) rather than at fixed offsets.
- Passages don't overlap, text that is mostly digits is left to word search, and code and data files are left out unless you set `semantic.code` (Lean proofs always are).
- Long files get their first 40 passages in a first round and the rest after every file has its start, as DigUp does.

With EmbeddingGemma 2, the model earlier versions ran, on a GitHub-hosted macOS runner, 188 text files with 10 copies among them:

| | DigUp's way | zsearch |
| --- | --- | --- |
| First index | 582 passages, 279k tokens, 721 s | 561 passages embedded and 48 reused, 235k tokens, 603 s |
| After editing 5 files | 10 passages, 8.8 s | 6 embedded, 4 reused, 5.9 s |
| After `zsearch index --rebuild` | everything again, about 720 s | nothing embedded, 0.1 s |

The first index saves what skipping overlap and reusing copies save; more copies save more. Packing passages together leaves each vector within 0.999 cosine of embedding it alone (0.9994 at worst), and on a CPU it is no faster. `bun scripts/bench-semantic/bench.ts --model=MODEL.gguf` runs the comparison.


It follows the index settings: it runs as part of an index update (so only while zsearch runs, and not at all with **Only when I ask** until you ask), Granite's pass waits with the rest of a big automatic update in Low Power Mode, runs at a low priority below 100% `indexLoad`, and never reads the files zsearch indexes by name only (keys, password files). The vectors live in files of their own next to the index (`index.semantic-fast.db` for Potion, `index.semantic.db` for Granite), as 16-bit floats like DigUp's: 8-bit numbers would take half the space, but with the real model they changed 2.7% of the top ten results.

## Query syntax

Filters can be combined with any mode:

| Filter | Example | Meaning |
| --- | --- | --- |
| `ext:` | `ext:pdf,docx` | File extension |
| `type:` | `type:doc`, `type:sheet`, `type:slides`, `type:code`, `type:image`, `type:folder`, `-type:pdf` | Kind of file. Aliases include `docs`, `spreadsheet`, `presentation`, `photo`, `music` and `notes` |
| `in:` | `in:~/Documents`, `in:Projects/site`, `in:"~/My Folder"` | Inside a folder (paths without `~` or `/` are relative to home; quote paths with spaces) |
| `path:` | `path:2024` | The path contains this text |
| `size:` | `size:>5mb`, `size:<100k`, `size:1mb..10mb` | File size |
| `mtime:` | `mtime:<7d`, `mtime:>1y`, `mtime:today`, `mtime:2023`, `after:2024-01-01`, `before:2024-06` | Modification time |
| `name:` / glob | `name:invoice`, `name:/^IMG_/i`, `*.pdf`, `IMG_????` | File name only; unquoted globs match the complete name |
| `sort:` | `sort:name`, `sort:-size`, `sort:date`, `sort:path` | Ascending order; prefix with `-` for descending |
| `created:` | `created:2024`, `created:<7d` | File-system creation date, when available |
| `tag:` | `tag:Research` | Finder tag, when metadata indexing is enabled |
| Match controls | `case:on`, `word:on`, `diacritics:off` | Override smart case, require whole words, or ignore Latin accents (Find) |
| `near:` / `NEAR/n` | `alpha beta near:3`, `alpha NEAR/3 beta` | Find these words in order, with at most three intervening words |
| `fold:` | `budget fold:on` | Preview only matches and two surrounding lines |
| `limit:` | `limit:20` | Number of results, capped at 5000 |

Use `all:budget report` to find both words anywhere in a file; `budget OR invoice` joins alternatives and `(budget OR invoice) type:pdf` combines groups. Branches retain the 5000-result and time budgets; a partial response reports truncation. Find suggests similar indexed words when nothing matches. Prefix any filter with `-` to invert it (except `limit:` and `sort:`). `kind:` aliases `type:`, `dir:` aliases `in:`, `modified:`/`changed:` alias `mtime:`, and `since:` aliases `after:`. Time units are `s`, `m`/`min`, `h`, `d`, `w`, `mo`, `y`; `size:=10mb` allows ±10%. Mode prefixes include `f:`/`fuzzy:`, `find:`/`exact:`, and `re:`/`regex:`; regex flags such as `/BUDGET/i` are preserved.

In fuzzy mode, `!word` excludes files whose path contains the word. A query made only of filters, such as `type:pdf mtime:<7d`, lists the matching files with the newest first. An empty query shows the files you opened recently, then the files modified most recently.

## Keys

| Keys | Action |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd>, <kbd>Ctrl-P</kbd> <kbd>Ctrl-N</kbd>, <kbd>Ctrl-K</kbd> <kbd>Ctrl-J</kbd>, mouse wheel | Move the selection |
| <kbd>PgUp</kbd> <kbd>PgDn</kbd> | Page through results |
| <kbd>Enter</kbd>, double-click | Open with the default app (or print the path with `-p`) |
| <kbd>Ctrl-E</kbd> | Open in your editor, at the matching line (`$VISUAL`/`$EDITOR`, or vim, VS Code, Zed, Sublime, Helix…) |
| <kbd>Ctrl-O</kbd> | Show in Finder or your file manager |
| <kbd>Ctrl-Y</kbd> / <kbd>Ctrl-Shift-Y</kbd> | Copy the selected path / all result paths |
| <kbd>Ctrl-Shift-X</kbd> | Exclude the selected file or folder and update the index |
| <kbd>Ctrl-Shift-O</kbd> | Cycle name, size, date and path sorting |
| <kbd>Ctrl-Shift-T</kbd> | Fold the preview around matches |
| <kbd>Tab</kbd> / <kbd>Shift-Tab</kbd>, <kbd>Alt-1</kbd> / <kbd>Alt-2</kbd> / <kbd>Alt-3</kbd> | Switch between find, fuzzy and semantic |
| <kbd>Ctrl-T</kbd> | Show or hide the preview |
| <kbd>Shift-↑</kbd> <kbd>Shift-↓</kbd>, <kbd>Ctrl-D</kbd> <kbd>Ctrl-U</kbd>, wheel over the preview | Scroll the preview |
| <kbd>Ctrl-F</kbd> / <kbd>Ctrl-B</kbd> | Jump to the next or previous match in the preview |
| <kbd>Ctrl-R</kbd> / <kbd>Ctrl-X</kbd> | Update the index / stop indexing |
| <kbd>Ctrl-S</kbd> | Settings: what to index, hidden files, contents |
| <kbd>F1</kbd> / <kbd>Ctrl-/</kbd> | Help |
| <kbd>Ctrl-C</kbd> | Quit |
| <kbd>Esc</kbd> | Clear the query; press again to quit |

Files you open through zsearch rank higher next time (frecency), and recently modified files get a small boost.

## Indexing

The first launch opens a short setup screen. You can choose these settings later with <kbd>Ctrl-S</kbd> or the `config` command.

- **Documents and Downloads** (the default) indexes `~/Documents` and `~/Downloads`. A folder that doesn't exist is skipped.
- **Home folder** indexes everything under `~`. On macOS this includes iCloud Drive and `~/Library/CloudStorage` (indexed by name only), but not the rest of `~/Library`.
- **Entire disk** indexes everything under `/`. It skips pseudo-filesystems, caches and VM images; `oneFileSystem:true` also skips other mounted volumes. System folders (`/usr`, `/opt`, `/etc`, `/Applications`, …) are indexed by name only, and your files are indexed in full. On macOS, give your terminal *Full Disk Access* to cover protected folders.
- **Custom folders** indexes a comma-separated list such as `~/Documents, ~/code`.

Setup can show roughly how long the first index of the chosen folders takes ("12,345 files · about 3 minutes"), from a quick count that opens no files: press <kbd>e</kbd> in the terminal app, or click *How long will this take?* in the Mac app. It counts only when asked, because walking a folder can bring up macOS's folder permission prompts. `zsearch estimate` prints the same for any folders. For a large folder the count stops after a few seconds and the estimate becomes a lower bound.

Indexing runs in two phases:

1. A **scan** walks the folders and records every file and folder. Name search works as soon as the scan has passed a file.
2. **Contents** are extracted in parallel worker threads and stored in a SQLite FTS5 index, with the most recently modified files first.

An update that starts on its own (the schedule, file changes, an index left out of date) waits while the computer is in Low Power Mode or running hot, if it has a thousand files or more to read, and picks up where it left off. Set `pauseOnBattery` to wait on battery as well, or `pauseOnLowPower` to `false` to never wait (both are in the Mac app's settings too). An update you ask for (Update Index Now, <kbd>Ctrl-R</kbd>, `zsearch index`, MCP's `update_index`) never waits.

Later runs re-read files whose size or modification time changed, or whose content settings changed, and remove deleted files. A rename on the same file system keeps extracted text when device, inode, size and modification time agree. Unavailable roots and folders that cannot be listed keep their existing entries; status reports them so you can restore permissions. Native file-system events trigger a debounced incremental refresh while the TUI, Mac engine or MCP server runs, with the timed scan as a fallback. Files that can't be read (encrypted, corrupt, permission denied) are recorded with the reason (`zsearch status --errors`) and aren't retried until they change.

**Keys and passwords stay out.** Private keys, certificates, key stores, password databases and login files (`id_rsa`, `*.pem`, `*.p12`, `*.p8`, `*.kdbx`, `*.gpg`, `.env` and `*.env`, `.netrc`, `.npmrc`, `credentials.json`, `secrets.yaml` and similar, and anything in `~/.ssh`, `~/.aws` or `~/.gnupg`) are indexed by name only, so you can still find them but their text is never read, previewed or given to MCP clients. A text file holding a private key block is left out the same way. `zsearch status --errors` lists them.

From the command line:

```sh
zsearch index                       # update the index with the saved settings
zsearch index ~/Documents ~/code    # index these folders (saved as the new roots)
zsearch index --home                # whole home folder
zsearch index --docs                # back to ~/Documents and ~/Downloads
zsearch index --disk                # whole disk
zsearch index --hidden              # include dotfiles
zsearch index --rebuild             # start from scratch
zsearch status                      # what is indexed
zsearch estimate --home             # how long a first index of ~ takes, roughly
```

### Supported file types

| Contents read from | Formats |
| --- | --- |
| Documents | PDF, DOCX/DOCM/DOTX, ODT, RTF, legacy DOC, EPUB |
| Spreadsheets | XLSX/XLSM, ODS, legacy XLS (sheets, shared strings, numbers) |
| Presentations | PPTX, ODP, legacy PPT (slides and speaker notes) |
| iWork | Single-file Pages, Numbers and Keynote archives with an embedded Quick Look PDF or an image preview (with OCR enabled); other iWork files stay names-only |
| Mail & notebooks | EML/EMLX (headers, plain text and HTML bodies), Jupyter `.ipynb` |
| Text | Code in ~100 languages, Markdown, reStructuredText, Org, LaTeX, HTML, XML, JSON, YAML, TOML, CSV, logs, config files, and any file without an extension that turns out to be text |
| Images and scans (Mac app) | PNG, JPEG, HEIC, TIFF, WebP, BMP, GIF, and PDF pages that have no text, read with OCR |

All other files (audio, video, archives, applications, and images outside the Mac app) are indexed by name, folder, size and date.

**Dataset folders.** A folder (other than an indexed folder itself) with 300 or more images, most of them named by a program (`frame_000123.png`, hashes, UUIDs, rather than `IMG_1234.jpg` or `Screenshot …`), is taken for a dataset: its images are indexed by name but not read with OCR. `zsearch status --errors` lists such folders; `zsearch config set skipDatasetOcr false` reads them too.

**OCR.** The Mac app bundles a small helper, `zsearch-ocr`, that reads text with Apple's Vision framework. It runs on the Mac, at low priority, and sends nothing anywhere. Images are read after all other files, and a PDF only goes through OCR for its pages without text (at most the first 100). Completed OCR pages are streamed and retained if the document deadline is reached. `zsearch doctor` says whether OCR is available. To use the helper with the terminal app, point `ZSEARCH_OCR` at it (`ZSEARCH_OCR=/Applications/zsearch.app/Contents/Helpers/zsearch-ocr`); turn it off with `zsearch config set content.ocr false`.

Each extraction worker enforces a per-file deadline and is replaced when a parser gets stuck; cancel terminates running workers and their tracked helper processes. Archives have a 16 MB per-entry, 32 MB total inflation budget and a 2048-part cap. Timed-out files appear in `status --errors` and retry when the file or content settings change.

## Configuration

Settings are stored in `~/.config/zsearch/config.json`. `zsearch config` prints them, `zsearch config set <key> <value>` changes one, and `zsearch config path` shows where the file is.

| Key | Default | |
| --- | --- | --- |
| `roots` | `["~/Documents", "~/Downloads"]` | Folders to index |
| `exclude` | `[]` | Extra gitignore-style patterns (`*.log`, `Downloads/`) or absolute folders (`~/VirtualBox VMs`) |
| `namesOnly` | `[]` | Folders whose files are indexed by name only |
| `includeHidden` | `false` | Index dotfiles and dot-folders |
| `respectGitignore` | `true` | Honour `.gitignore` and `.ignore`; `.zsearchignore` always applies |
| `followSymlinks` | `false` | Follow file and folder links whose resolved targets stay in authorized roots and obey exclusions, ignore rules and names-only policy (loops are detected) |
| `oneFileSystem` | `false` | Stay on each root’s file system; turn on to skip other mounts |
| `cloudContent` | `false` | Read contents inside iCloud Drive / CloudStorage (may download files) |
| `content.enabled` | `true` | Read the text inside files |
| `content.maxDocumentMB` | `64` | Largest PDF or Office file to read |
| `content.maxTextMB` | `8` | Largest plain-text file to read |
| `content.maxChars` | `2000000` | Text kept per file |
| `content.metadata` | `false` | Index selected EXIF fields, PDF titles and Finder tags (Mac); obeys content privacy settings |
| `content.ocr` | `true` | Read the text in images and scanned PDF pages, when the OCR helper is available (macOS) |
| `liveUpdates` | `true` | Watch roots for changes while a frontend is running; updates still walk the selected roots |
| `autoRefreshMinutes` | `60` | Refresh the index in the background when it is older than this (`0` = off) |
| `workers` | `0` | Extraction threads (`0` = automatic: the CPUs less two, at most 8, within `indexLoad`) |
| `pauseOnLowPower` | `true` | A big update that starts on its own waits in Low Power Mode and while the computer is hot |
| `pauseOnBattery` | `false` | ...and while on battery |
| `skipDatasetOcr` | `true` | Leave images in machine-made dataset folders out of OCR (they stay findable by name) |
| `indexLoad` | `70` | How much of the computer indexing may use, in percent: of its CPUs and CPU time. Below `100`, indexing also reads and writes the disk at a low priority, so other apps go first |
| `editor` | `""` | Existing editor executable and fixed arguments (defaults to `$VISUAL` / `$EDITOR`); command interpreters are rejected |
| `semantic.enabled` | `false` | Read files for meaning when indexing (`zsearch semantic install` turns it on) |
| `semantic.declined` | `false` | Set by turning semantic search off: the Mac app then stops downloading its models when it starts |
| `semantic.code` | `false` | ...and source code and data files |
| `defaultMode` | `find` | Initial search mode (`find`, `fuzzy` or `semantic`) |
| `preview` | `true` | Show the preview pane |

To update the index only when you ask (the Mac app's **Update Index Now**, `^R` in the terminal app, `zsearch index`, or the MCP `update_index` tool), set `autoRefreshMinutes` to `0` and `liveUpdates` to `false`: `zsearch config set autoRefreshMinutes 0` and `zsearch config set liveUpdates false`, or pick **Only when I ask** under "Update the index" in the Mac app. Changing folders or what to read then waits for the next update too, in both apps. With a schedule picked, the Mac app's **Also update as files change** switch sets `liveUpdates`. Setting up for the first time, and excluding a result, still update the index.

Environment variables: `ZSEARCH_HOME` keeps config and index in one folder (handy for testing). `ZSEARCH_DB` overrides the index path. `ZSEARCH_NO_PDFTOTEXT=1` (also `true`/`yes`/`on`) forces the built-in PDF reader. `ZSEARCH_NO_PDFTOTEXT=0` leaves Poppler enabled. `ZSEARCH_OCR` names the OCR helper (`0` turns OCR off). `ZSEARCH_POWER=low-power,hot,battery` (any of them) stands in for the computer's power state, to see background runs wait. `ZSEARCH_EMBED` names the embedding helper (`0` turns semantic search off), and `ZSEARCH_MODELS` the folder the model is in.

The index is stored at `~/.local/share/zsearch/index.db` (`~/Library/Application Support/zsearch/index.db` on macOS). `zsearch reset` deletes it. App-owned data/config folders use mode 0700 and config, database and journals use 0600. The schema changes rebuild older indexes to correct non-Latin token matching. An index from the previous schema (version 9) is upgraded in place on the next update instead: nothing is read from disk again. What OCR read in images and scanned PDFs is kept by file, so later rebuilds do not run OCR again on files that have not changed.

## Use it from Claude and other AI apps (MCP)

`zsearch mcp` runs zsearch as a [Model Context Protocol](https://modelcontextprotocol.io) server on stdin/stdout, so Claude Code, Claude Desktop, Codex, OpenCode and other MCP clients can search your files and read what is in them. It uses the same index and settings as the terminal app and the Mac app, and everything still stays on your machine: the assistant only sees the results and file text it asks for, within your currently authorized roots and content policy. Symlink targets outside those roots, excluded files, names-only contents and credential paths are not exposed. Change indexing scope in the local app or CLI; MCP cannot widen it.

**Claude Code**

```sh
claude mcp add --scope user zsearch -- zsearch mcp
```

**Claude Desktop.** Open *Settings › Developer › Edit Config* (`~/Library/Application Support/Claude/claude_desktop_config.json`) and add zsearch, then restart Claude:

```json
{
  "mcpServers": {
    "zsearch": { "command": "/Users/you/.local/bin/zsearch", "args": ["mcp"] }
  }
}
```

Desktop apps don't see your shell's `PATH`, so give the full path. For a standalone binary (`bun run build`) it's where you copied it (`command -v zsearch` shows it). With `bun link` from a clone, run it with Bun: `"command": "/Users/you/.bun/bin/bun", "args": ["/path/to/zsearch/src/main.ts", "mcp"]`. If you have the Mac app, its engine works too: `"command": "/Users/you/Applications/zsearch.app/Contents/Helpers/zsearch"`.

**Codex**

```sh
codex mcp add zsearch -- zsearch mcp
```

This writes the server to `~/.codex/config.toml`, which you can also edit by hand:

```toml
[mcp_servers.zsearch]
command = "zsearch"
args = ["mcp"]
tool_timeout_sec = 300   # optional: Codex stops waiting for a tool after 60 s by default, which cuts short a long `update_index` wait
```

**OpenCode.** Add zsearch under `mcp` in `~/.config/opencode/opencode.json` (or a project's `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "zsearch": { "type": "local", "command": ["zsearch", "mcp"] }
  }
}
```

Other MCP clients (Cursor, VS Code, Zed, …) take the same command: `zsearch mcp`. Every client gets the tools below. The resources and prompts show up only in clients that support them.

| Tool | What it does |
| --- | --- |
| `search` | Find files by name and contents, with everything the query syntax offers: exact text, `regex`, `fuzzy` mode, and filters as arguments (`type`, `exclude_type`, `ext`, `folder`, `path`, `modified`, `after`, `before`, `size`) or in the query (`type:pdf mtime:<30d`). Returns paths, kinds, sizes, dates and the matching lines with line and page numbers; `offset` pages through long result lists |
| `read_file` | Read an indexed file's text with line numbers: the extracted text of PDFs and Office files (with page, slide and sheet markers), or the file itself for code and text. `query` marks the matches and starts at the first one; `matches_only` returns just the matching lines with context |
| `index_status` | What is indexed, when it was last updated, indexing progress, and (with `errors`) the files that could not be read |
| `update_index` | Update the locally configured roots in the background, or rebuild the index; `wait_seconds` waits for it with progress notifications |
| `exclude_path` | Exclude an already indexed file or folder and request a refresh; this only narrows access |
| `cancel_index` | Stop indexing |
| `get_config` / `set_config` | Read settings; change only search mode, preview, worker/load and refresh preferences. Roots, editor and all content/privacy controls require the local app or CLI |

Resources: `zsearch://status`, `zsearch://config`, `zsearch://query-syntax`, and each indexed file's text as `file:///path/to/file`. Prompts: `find_files` (find files about something and say what is in them) and `summarize_file` (with path completion). If the index is older than `autoRefreshMinutes`, the server updates it in the background, as the app does. The server reads only files that are in the index, and never changes them.

## Command line

```text
zsearch [query]                 open the interactive search
zsearch search <query>          print matches and exit (-m find|fuzzy|semantic, -e regex, -n limit, -l paths only, -0, --csv, --sort, --json)
zsearch index [folders...]      build or update the index (--docs, --home, --disk, --hidden, --rebuild, -q)
zsearch status [--errors]       what is indexed (--json)
zsearch estimate [folders...]   how long a first index takes, roughly (--docs, --home, --disk, --json)
zsearch config [show|get|set|path|reset]
zsearch duplicates [--json]      find identical files by size and streaming SHA-256
zsearch exclude <path>          exclude an indexed file or folder and update
zsearch semantic [status|install|remove]  semantic search: download the model (--no-images), or delete it
zsearch doctor                  check SQLite/FTS5, pdftotext, OCR, the embedding helper and the index
zsearch reset                   delete the index
zsearch serve                   JSON lines on stdin/stdout, for the Mac app (see src/serve.ts)
zsearch mcp                     MCP server on stdin/stdout, for Claude and other AI apps (see above)
```

`zsearch search` exits with 0 when it finds matches, 1 when it finds none and 2 on errors, the same as `grep`:

```sh
zsearch search -0 'type:pdf invoice mtime:<30d' | xargs -0 -I{} cp {} ~/invoices/
zsearch search --json -e 'TODO\(\w+\)' | jq '.hits[].path'
```

## How it works

```
src/
  index/      crawler (gitignore-aware walk) → extraction workers → SQLite writer
    extract/  zip/OOXML/ODF/EPUB, OLE2 (.doc/.xls/.ppt), PDF, RTF, email, text decoding
  search/     query parser, fzf-style matcher, FTS5 keyword search, regex planner,
              vocabulary index, snippets, fusion/ranking, search worker
  semantic/   semantic search: passages, the embedding helper, the semantic index, ranking
  tui/        Solid + OpenTUI app: setup, results, preview, status, help
  cli.ts      command line
  serve.ts    the engine over JSON lines, for the Mac app
  mcp/        the engine as an MCP server: protocol (rpc.ts) and tools (server.ts)
native/embed/  zsearch-embed: the Granite embedding model on llama.cpp, for semantic search
macos/        SwiftUI app that runs `zsearch serve` (see macos/README.md)
```

- **Storage.** There is one SQLite database in WAL mode. A `files` table holds every path. A contentless FTS5 table indexes file names, folder names and contents (`unicode61`, Latin diacritics removed). It records which column holds each word but not word positions, which keeps it small; exact text is always checked against the stored text. Extracted text is stored once: raw below 1 KB, deflate below 16 KB, zstd above. The vocabulary of every indexed term is kept as compressed, append-only chunks.
- **Names.** All paths are kept in memory in the search worker and matched with an fzf v1-style algorithm. Each path has a precomputed character bitmask for quick rejection, a bounded top-k keeps only the best results, and the next keystroke searches only the previous matches (as fzf and fff do). The list lives in typed arrays, about 300 MB for a million paths. After an index update the worker reads only the changed rows and a log of removed files, instead of every path again. The recent-files list (shown before you type) is a top-k pass over modification times. Decoded-text cache invalidation follows changed/deleted row IDs, and opening history reloads only when it changes.
- **Find.** Plain text is searched as a literal. A regex is parsed into a boolean condition over the literal strings every match must contain (in the spirit of Russ Cox's trigram index). Each literal is mapped onto index terms (whole token, prefix, suffix or substring), using an in-memory copy of the vocabulary for substring lookups. Only the candidate files are read and scanned with the real regex. Patterns with no usable literal fall back to a time-boxed scan of all stored text.
- **Ranking.** Name matches and content matches are fused with reciprocal-rank fusion (fuzzy mode ranks content BM25-style: words in the file name, then the folders, then how often they occur in the text). Frecency and recency then adjust the result.
- **Responsiveness.** Indexing runs in a worker thread with its own pool of extraction workers. Searching runs in another worker, which cancels superseded queries and is restarted by a watchdog if a pathological regex runs too long. The UI thread only draws.

## Planned

- Index only paths reported by file-system events rather than walking all configured roots on each refresh.
- Full iWork IWA text parsing; embedded PDF and image previews are supported already.

## Development

```sh
bun install
bun test --timeout 60000        # unit, TUI and end-to-end tests (duration depends on enabled end-to-end tests and host)
bun run typecheck
bun run build                   # dist/zsearch
bun run bench                   # index and search benchmark on a generated corpus (--files=N, --compare=old.json)
bun run bench --corpus=real     # the same, plus real projects (MDN docs, Kubernetes) fetched once into ~/.cache
scripts/build-embed.sh          # dist/zsearch-embed, the embedding helper (llama.cpp; needs CMake and a C++ compiler)
bun scripts/bench-semantic/bench.ts --model=…gguf   # reading for meaning, against the way DigUp does it
bun scripts/bench-semantic/quality.ts --model=…gguf # results with the stored vectors, against full precision and 8-bit
bun run fixtures                # regenerate document fixtures (needs python-docx, openpyxl, python-pptx, reportlab, xlwt, Pillow)
```

The end-to-end tests drive the real app in a pseudo-terminal through [pyte](https://github.com/selectel/pyte) (`pip install pyte`). They run against `bun src/main.ts` and, if it has been built, against `dist/zsearch`. TUI component tests use OpenTUI's test renderer. No network access is needed.

## Acknowledgements

zsearch is inspired by [fzf](https://github.com/junegunn/fzf) (matching algorithm and operators), [fff](https://github.com/dmtrKovalenko/fff) (frecency and typo-resistant file search) and [fsearch](https://github.com/noahdunnagan/fsearch) (query filters such as `in:`, `type:`, `size:` and `mtime:`). It is built on [OpenTUI](https://github.com/anomalyco/opentui), [SQLite FTS5](https://sqlite.org/fts5.html) and [unpdf](https://github.com/unjs/unpdf) / pdf.js. The legacy Office test files come from [Apache POI](https://github.com/apache/poi). Semantic search adapts [DigUp](https://github.com/ARahim3/DigUp)'s ranking and model runtime (MIT), runs on [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT) and uses Minish Lab's potion-retrieval-32M and IBM's granite-embedding-small-english-r2, downloaded when the app starts; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT
