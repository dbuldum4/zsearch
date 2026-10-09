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

- **Two search modes, no guessing.** *Find* (the default) looks for the exact text you type in file names and contents; wrap the query in slashes (`/\d{4}-\d{2}/`) for a regular expression. *Fuzzy* is fzf-style name matching that forgives typos. Press <kbd>Tab</kbd> to switch.
- **It looks inside files.** It reads PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP, RTF, EPUB, EML, Jupyter notebooks, legacy `.doc`, `.xls` and `.ppt`, source code, Markdown, HTML, CSV, JSON, logs and other text. It shows which page, slide, sheet or line matched.
- **Setup is guided.** On first launch, zsearch asks what to index (Documents and Downloads, home folder, whole disk or chosen folders) and whether to read file contents or include hidden files. Indexing runs in the background with a progress bar, and results appear while it runs.
- **Updates are incremental.** Only new or changed files are read again. The index refreshes itself when it is older than an hour; press <kbd>Ctrl-R</kbd> to refresh it now.
- **Defaults keep the index clean.** zsearch follows `.gitignore`. It skips `node_modules`, VCS folders, caches, trash and package-manager stores, and its own data. On macOS it treats app bundles as single files. It never reads cloud "online-only" placeholders, because reading them would download them. Hidden files are left out unless you turn them on.
- **It is fast and small.** On the benchmark corpus (`bun run bench`: 20,000 files, 80 MB), a full index takes about 14 s and makes a 70 MB index. Find takes 5–20 ms, fuzzy name search about 15–25 ms, and a regex that reads every file about 15–55 ms. Search runs in a worker thread, so typing never stutters.
- **Everything stays local.** The index is a SQLite file on your machine, and zsearch makes no network requests.

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

There is also a native Mac app (SwiftUI, macOS 14 or newer, Apple silicon) with the same engine inside. It has a settings pane (folders, what to read, automatic updates, index size and rebuild), a menu bar item, and a shortcut (⌥ Space by default) that brings it forward from any app. Every pull request and every push to `main` builds a DMG on GitHub Actions and publishes it as a pre-release. To install one from a clone:

```sh
macos/scripts/install-preview.sh main       # latest main
macos/scripts/install-preview.sh 12         # pull request #12
```

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
| **fuzzy** | Matches file paths the way fzf does: subsequences, with bonuses for word starts, `camelCase`, path separators and runs of consecutive letters, and a preference for the file name over the folders. Typos are forgiven (`mian` finds `main.rs`, `recieve` finds `receive.py`). Content matches are typo-tolerant too. Supports fzf operators: `'exact` `^prefix` `suffix$` `!exclude`. | Finding a file whose name you half remember |

Find narrows the candidates through the index first (the literal parts of a regex too), so most searches don't have to read every file. Results are ordered by number of matches, newest files first among equals; a file whose name matches comes first. `f:…` runs one query in fuzzy mode.

## Query syntax

Filters can be combined with any mode:

| Filter | Example | Meaning |
| --- | --- | --- |
| `ext:` | `ext:pdf,docx` | File extension |
| `type:` | `type:doc`, `type:sheet`, `type:slides`, `type:code`, `type:image`, `type:folder`, `-type:pdf` | Kind of file. Aliases include `docs`, `spreadsheet`, `presentation`, `photo`, `music` and `notes` |
| `in:` | `in:~/Documents`, `in:Projects/site` | Inside a folder (paths without `~` or `/` are relative to home) |
| `path:` | `path:2024` | The path contains this text |
| `size:` | `size:>5mb`, `size:<100k`, `size:1mb..10mb` | File size |
| `mtime:` | `mtime:<7d`, `mtime:>1y`, `mtime:today`, `mtime:2023`, `after:2024-01-01`, `before:2024-06` | Modification time |
| `limit:` | `limit:20` | Number of results |

In fuzzy mode, `!word` excludes files whose path contains the word. A query made only of filters, such as `type:pdf mtime:<7d`, lists the matching files with the newest first. An empty query shows the files you opened recently, then the files modified most recently.

## Keys

| Keys | Action |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd>, <kbd>Ctrl-P</kbd> <kbd>Ctrl-N</kbd>, <kbd>Ctrl-K</kbd> <kbd>Ctrl-J</kbd>, mouse wheel | Move the selection |
| <kbd>PgUp</kbd> <kbd>PgDn</kbd> | Page through results |
| <kbd>Enter</kbd>, double-click | Open with the default app (or print the path with `-p`) |
| <kbd>Ctrl-E</kbd> | Open in your editor, at the matching line (`$VISUAL`/`$EDITOR`, or vim, VS Code, Zed, Sublime, Helix…) |
| <kbd>Ctrl-O</kbd> | Show in Finder or your file manager |
| <kbd>Ctrl-Y</kbd> | Copy the path |
| <kbd>Tab</kbd>, <kbd>Alt-1</kbd> / <kbd>Alt-2</kbd> | Switch between find and fuzzy |
| <kbd>Ctrl-T</kbd> | Show or hide the preview |
| <kbd>Shift-↑</kbd> <kbd>Shift-↓</kbd>, <kbd>Ctrl-D</kbd> <kbd>Ctrl-U</kbd>, wheel over the preview | Scroll the preview |
| <kbd>Ctrl-F</kbd> / <kbd>Ctrl-B</kbd> | Jump to the next or previous match in the preview |
| <kbd>Ctrl-R</kbd> / <kbd>Ctrl-X</kbd> | Update the index / stop indexing |
| <kbd>Ctrl-S</kbd> | Settings: what to index, hidden files, contents |
| <kbd>F1</kbd> | Help |
| <kbd>Esc</kbd> | Clear the query; press again to quit |

Files you open through zsearch rank higher next time (frecency), and recently modified files get a small boost.

## Indexing

The first launch opens a short setup screen. You can choose these settings later with <kbd>Ctrl-S</kbd> or the `config` command.

- **Documents and Downloads** (the default) indexes `~/Documents` and `~/Downloads`. A folder that doesn't exist is skipped.
- **Home folder** indexes everything under `~`. On macOS this includes iCloud Drive and `~/Library/CloudStorage` (indexed by name only), but not the rest of `~/Library`.
- **Entire disk** indexes everything under `/`. It skips pseudo-filesystems, caches, other mounted volumes and VM images. System folders (`/usr`, `/opt`, `/etc`, `/Applications`, …) are indexed by name only, and your files are indexed in full. On macOS, give your terminal *Full Disk Access* to cover protected folders.
- **Custom folders** indexes a comma-separated list such as `~/Documents, ~/code`.

Indexing runs in two phases:

1. A **scan** walks the folders and records every file and folder. Name search works as soon as the scan has passed a file.
2. **Contents** are extracted in parallel worker threads and stored in a SQLite FTS5 index, with the most recently modified files first.

Later runs only re-read files whose size or modification time changed, and they remove deleted files. Files that can't be read (encrypted, corrupt, permission denied) are recorded with the reason (`zsearch status --errors`) and aren't retried until they change.

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
```

### Supported file types

| Contents read from | Formats |
| --- | --- |
| Documents | PDF, DOCX/DOCM/DOTX, ODT, RTF, legacy DOC, EPUB |
| Spreadsheets | XLSX/XLSM, ODS, legacy XLS (sheets, shared strings, numbers) |
| Presentations | PPTX, ODP, legacy PPT (slides and speaker notes) |
| Mail & notebooks | EML/EMLX (headers, plain text and HTML bodies), Jupyter `.ipynb` |
| Text | Code in ~100 languages, Markdown, reStructuredText, Org, LaTeX, HTML, XML, JSON, YAML, TOML, CSV, logs, config files, and any file without an extension that turns out to be text |

All other files (images, audio, video, archives, applications) are indexed by name, folder, size and date.

## Configuration

Settings are stored in `~/.config/zsearch/config.json`. `zsearch config` prints them, `zsearch config set <key> <value>` changes one, and `zsearch config path` shows where the file is.

| Key | Default | |
| --- | --- | --- |
| `roots` | `["~/Documents", "~/Downloads"]` | Folders to index |
| `exclude` | `[]` | Extra gitignore-style patterns (`*.log`, `Downloads/`) or absolute folders (`~/VirtualBox VMs`) |
| `namesOnly` | `[]` | Folders whose files are indexed by name only |
| `includeHidden` | `false` | Index dotfiles and dot-folders |
| `respectGitignore` | `true` | Honour `.gitignore`, `.ignore` and `.zsearchignore` |
| `followSymlinks` | `false` | Follow symlinked folders (loops are detected) |
| `cloudContent` | `false` | Read contents inside iCloud Drive / CloudStorage (may download files) |
| `content.enabled` | `true` | Read the text inside files |
| `content.maxDocumentMB` | `64` | Largest PDF or Office file to read |
| `content.maxTextMB` | `8` | Largest plain-text file to read |
| `content.maxChars` | `2000000` | Text kept per file |
| `autoRefreshMinutes` | `60` | Refresh the index in the background when it is older than this (`0` = off) |
| `workers` | `0` | Extraction threads (`0` = number of CPUs − 1, at most 8) |
| `editor` | `""` | Editor command (defaults to `$VISUAL` / `$EDITOR`) |
| `defaultMode` | `find` | Initial search mode (`find` or `fuzzy`) |
| `preview` | `true` | Show the preview pane |

Environment variables: `ZSEARCH_HOME` keeps config and index in one folder (handy for testing). `ZSEARCH_DB` overrides the index path. `ZSEARCH_NO_PDFTOTEXT=1` forces the built-in PDF reader.

The index is stored at `~/.local/share/zsearch/index.db` (`~/Library/Application Support/zsearch/index.db` on macOS). `zsearch reset` deletes it.

## Command line

```text
zsearch [query]                 open the interactive search
zsearch search <query>          print matches and exit (-m find|fuzzy, -e regex, -n limit, -l paths only, --json)
zsearch index [folders...]      build or update the index (--docs, --home, --disk, --hidden, --rebuild, -q)
zsearch status [--errors]       what is indexed (--json)
zsearch config [show|get|set|path|reset]
zsearch doctor                  check SQLite/FTS5, pdftotext and the index
zsearch reset                   delete the index
zsearch serve                   JSON lines on stdin/stdout, for the Mac app (see src/serve.ts)
```

`zsearch search` exits with 0 when it finds matches, 1 when it finds none and 2 on errors, the same as `grep`:

```sh
zsearch search -l 'type:pdf invoice mtime:<30d' | xargs -I{} cp {} ~/invoices/
zsearch search --json -e 'TODO\(\w+\)' | jq '.hits[].path'
```

## How it works

```
src/
  index/      crawler (gitignore-aware walk) → extraction workers → SQLite writer
    extract/  zip/OOXML/ODF/EPUB, OLE2 (.doc/.xls/.ppt), PDF, RTF, email, text decoding
  search/     query parser, fzf-style matcher, FTS5 keyword search, regex planner,
              vocabulary index, snippets, fusion/ranking, search worker
  tui/        Solid + OpenTUI app: setup, results, preview, status, help
  cli.ts      command line
  serve.ts    the engine over JSON lines, for the Mac app
macos/        SwiftUI app that runs `zsearch serve` (see macos/README.md)
```

- **Storage.** There is one SQLite database in WAL mode. A `files` table holds every path. A contentless FTS5 table indexes file names, folder names and contents (`unicode61`, diacritics removed). It records which column holds each word but not word positions, which keeps it small; exact text is always checked against the stored text. Extracted text is stored once: raw below 1 KB, deflate below 16 KB, zstd above. The vocabulary of every indexed term is kept as compressed, append-only chunks.
- **Names.** All paths are kept in memory in the search worker and matched with an fzf v1-style algorithm. Each path has a precomputed character bitmask for quick rejection, a bounded top-k keeps only the best results, and the next keystroke searches only the previous matches (as fzf and fff do).
- **Find.** Plain text is searched as a literal. A regex is parsed into a boolean condition over the literal strings every match must contain (in the spirit of Russ Cox's trigram index). Each literal is mapped onto index terms (whole token, prefix, suffix or substring), using an in-memory copy of the vocabulary for substring lookups. Only the candidate files are read and scanned with the real regex. Patterns with no usable literal fall back to a time-boxed scan of all stored text.
- **Ranking.** Name matches and content matches are fused with reciprocal-rank fusion (fuzzy mode ranks content BM25-style: words in the file name, then the folders, then how often they occur in the text). Frecency and recency then adjust the result.
- **Responsiveness.** Indexing runs in a worker thread with its own pool of extraction workers. Searching runs in another worker, which cancels superseded queries and is restarted by a watchdog if a pathological regex runs too long. The UI thread only draws.

## Development

```sh
bun install
bun test --timeout 60000        # unit, TUI and end-to-end tests (~30 s)
bun run typecheck
bun run build                   # dist/zsearch
bun run bench                   # index and search benchmark on a generated corpus (--files=N, --compare=old.json)
bun run fixtures                # regenerate document fixtures (needs python-docx, openpyxl, python-pptx, reportlab, xlwt)
```

The end-to-end tests drive the real app in a pseudo-terminal through [pyte](https://github.com/selectel/pyte) (`pip install pyte`). They run against `bun src/main.ts` and, if it has been built, against `dist/zsearch`. TUI component tests use OpenTUI's test renderer. No network access is needed.

## Acknowledgements

zsearch is inspired by [fzf](https://github.com/junegunn/fzf) (matching algorithm and operators), [fff](https://github.com/dmtrKovalenko/fff) (frecency and typo-resistant file search) and [fsearch](https://github.com/noahdunnagan/fsearch) (query filters such as `in:`, `type:`, `size:` and `mtime:`). It is built on [OpenTUI](https://github.com/anomalyco/opentui), [SQLite FTS5](https://sqlite.org/fts5.html) and [unpdf](https://github.com/unjs/unpdf) / pdf.js. The legacy Office test files come from [Apache POI](https://github.com/apache/poi).

## License

MIT
