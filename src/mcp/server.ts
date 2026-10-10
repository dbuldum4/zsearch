/**
 * `zsearch mcp`: the search engine as a Model Context Protocol server on stdio, so AI
 * assistants (Claude Desktop, Claude Code and other MCP clients) can search the user's files.
 *
 * Tools: search, read_file, index_status, update_index, cancel_index, get_config, set_config.
 * Resources: the index status, the settings, the query syntax, and each indexed file's text
 * (file:// URIs). Prompts: find_files, summarize_file.
 */
import type { Database } from "bun:sqlite"
import { existsSync, statSync } from "node:fs"
import { progressLine } from "../cli.ts"
import { type Config, defaultConfig, ensureDirs, loadConfig, resolvePath, saveConfig, tildify } from "../config.ts"
import { type IndexStats, openDb, readContent } from "../index/db.ts"
import { type IndexOutcome, IndexRun } from "../index/client.ts"
import type { IndexProgress } from "../index/indexer.ts"
import { lockHolder } from "../index/lock.ts"
import { KIND_ALIASES, type Kind } from "../kinds.ts"
import { pdftotextPath } from "../platform.ts"
import { SearchClient } from "../search/client.ts"
import type { Preview, SearchHit, SearchResponse } from "../search/engine.ts"
import type { Mode } from "../search/query.ts"
import { formatBytes, formatCount, formatDate, formatDuration } from "../util/text.ts"
import {
  type JsonSchema,
  type LogLevel,
  McpServer,
  type Prompt,
  type Resource,
  type ResourceContents,
  type ResourceTemplate,
  RpcError,
  ErrorCode,
  serveStdio,
  type Tool,
  ToolError,
} from "./rpc.ts"

export const INSTRUCTIONS = `zsearch searches the files on this computer that the user chose to index: their names and folders, and the text inside PDFs, Word, Excel, PowerPoint and OpenDocument files, EPUB, e-mail, Jupyter notebooks, code, Markdown and plain text. Everything stays on this computer.

- Use \`search\` to find files. By default it finds the exact text you give in file names and contents (case-insensitive unless the query has a capital letter); set \`regex\` for a regular expression, or mode "fuzzy" for a file name you only half remember. Narrow results with \`type\` (doc, pdf, sheet, slides, code, image, folder…), \`ext\`, \`folder\`, \`modified\` and \`size\`. An empty query lists recently opened and modified files.
- Use \`read_file\` to read a file's text (the text zsearch extracted, so it works for PDFs and Office files too). Give the same \`query\` to jump to the matches, or \`matches_only\` to see just the matching lines.
- Only indexed folders are searched. \`index_status\` shows which folders are indexed and how fresh the index is; \`update_index\` refreshes it or indexes other folders.`

/** Lines of text a read_file call returns at most. */
const MAX_READ_LINES = 2000
/** Characters of a file's text a resource read or a prompt carries at most. */
const MAX_RESOURCE_CHARS = 1_000_000
const PROMPT_CHARS = 200_000
/** How often the server checks whether the index is due for its automatic update. */
const AUTO_CHECK_MS = 60_000

/* ----------------------------------------------------------------- host -- */

type RunState = { handle: IndexRun; progress: IndexProgress | null; startedAt: number; reason: "requested" | "auto"; done: Promise<IndexOutcome> }
type LastRun = { status: "done" | "cancelled" | "error" | "locked"; finishedAt: number; progress?: IndexProgress; error?: string }

/** The engine behind the tools: the search worker, index runs and the settings. */
export class Host {
  readonly paths = ensureDirs()
  config: Config
  private client: SearchClient
  private queue: Promise<unknown> = Promise.resolve()
  private db: Database | null = null
  run: RunState | null = null
  lastRun: LastRun | null = null
  private listeners = new Set<(p: IndexProgress) => void>()
  private lastAutoAttempt = 0
  private timer: ReturnType<typeof setInterval> | null = null
  log: (level: LogLevel, data: unknown) => void = () => {}

  constructor(readonly version: string) {
    this.config = loadConfig()
    this.client = new SearchClient(this.paths.db, this.config)
    this.client.onRestart = (reason) => this.log("warning", reason)
  }

  /** Start the automatic index updates the `autoRefreshMinutes` setting asks for. */
  startAutoRefresh() {
    const check = () => void this.autoRefresh().catch(() => {})
    check()
    this.timer = setInterval(check, AUTO_CHECK_MS)
    this.timer.unref?.()
  }

  private async autoRefresh() {
    const period = this.reloadConfig().autoRefreshMinutes * 60_000
    if (period <= 0 || this.run || Date.now() - this.lastAutoAttempt < period) return
    const { stats } = await this.stats()
    // A first index is the user's call (which folders?), not an automatic one.
    if (stats.lastIndexedAt === null || Date.now() - stats.lastIndexedAt < period) return
    if (lockHolder(this.paths.lock) !== null) return
    this.lastAutoAttempt = Date.now()
    this.log("info", `Updating the index: it is older than ${this.config.autoRefreshMinutes} minutes.`)
    this.startIndex(false, "auto")
  }

  /** Pick up settings changed elsewhere (the app, the terminal UI, `zsearch config`). */
  reloadConfig(): Config {
    const next = loadConfig()
    if (JSON.stringify(next) !== JSON.stringify(this.config)) this.applyConfig(next)
    return this.config
  }

  applyConfig(config: Config) {
    this.config = config
    this.client.setConfig(config)
  }

  /** One worker request at a time: the worker answers only the newest request of each kind. */
  private exclusive<T>(f: () => Promise<T | null>): Promise<T> {
    const next = this.queue.then(f, f)
    this.queue = next.catch(() => {})
    return next.then((v) => {
      if (v === null) throw new ToolError("the search was interrupted (the search worker restarted); try again")
      return v
    })
  }

  search(query: string, mode: Mode, limit: number): Promise<SearchResponse> {
    return this.exclusive(() => this.client.search(query, mode, limit))
  }

  preview(id: number, query: string, mode: Mode, focusLine?: number, window?: number): Promise<Preview> {
    return this.exclusive(() => this.client.preview(id, query, mode, focusLine, window))
  }

  stats(): Promise<{ stats: IndexStats }> {
    return this.exclusive(() => this.client.stats())
  }

  /** A connection of this thread's own, for lookups the worker protocol does not cover. */
  private database(): Database {
    this.db ??= openDb(this.paths.db, { readonly: true })
    return this.db
  }

  /** The indexed file at `path` (absolute or `~/…`), ignoring case only when nothing matches exactly. */
  async findFile(path: string): Promise<{ id: number; path: string; kind: Kind } | null> {
    // The worker creates the index on its first start.
    await this.client.waitReady()
    const abs = resolvePath(path.trim())
    const db = this.database()
    const exact = db.query("SELECT id, path, kind FROM files WHERE path = ?").get(abs) as { id: number; path: string; kind: Kind } | null
    if (exact) return exact
    const loose = db.query("SELECT id, path, kind FROM files WHERE path = ? COLLATE NOCASE LIMIT 2").all(abs) as { id: number; path: string; kind: Kind }[]
    return loose.length === 1 ? loose[0]! : null
  }

  storedText(id: number): string | null {
    return readContent(this.database(), id)
  }

  async unreadable(limit: number): Promise<{ path: string; reason: string }[]> {
    await this.client.waitReady()
    const rows = this.database().query("SELECT path, note FROM files WHERE content_state = 2 ORDER BY path LIMIT ?").all(limit) as { path: string; note: string | null }[]
    return rows.map((r) => ({ path: r.path, reason: r.note ?? "error" }))
  }

  /** Start an index run with the current settings, unless one is running here or elsewhere. */
  startIndex(rebuild: boolean, reason: RunState["reason"] = "requested"): { status: "started" | "running" } | { status: "busy"; pid: number } {
    if (this.run) return { status: "running" }
    const other = lockHolder(this.paths.lock)
    if (other !== null) return { status: "busy", pid: other }
    const handle = new IndexRun(
      this.config,
      this.paths.db,
      this.paths.lock,
      {
        onProgress: (p) => {
          if (this.run) this.run.progress = p
          for (const l of this.listeners) l(p)
        },
        onCommit: () => this.client.refresh(),
      },
      rebuild,
    )
    const run: RunState = { handle, progress: null, startedAt: Date.now(), reason, done: handle.done }
    this.run = run
    void handle.done.then((outcome) => {
      this.run = null
      this.client.refresh(true)
      const finishedAt = Date.now()
      if (outcome.status === "fatal") this.lastRun = { status: "error", finishedAt, error: outcome.error }
      else if (outcome.status === "locked") this.lastRun = { status: "locked", finishedAt }
      else this.lastRun = { status: outcome.status, finishedAt, progress: outcome.progress, error: outcome.progress.error }
      const p = this.lastRun.progress
      this.log(
        this.lastRun.status === "error" ? "error" : "info",
        this.lastRun.status === "done" && p
          ? `Index updated in ${formatDuration(p.elapsedMs)}: ${formatCount(p.added)} new, ${formatCount(p.updated)} changed, ${formatCount(p.removed)} removed.`
          : `Indexing ${this.lastRun.status}${this.lastRun.error ? `: ${this.lastRun.error}` : ""}.`,
      )
    })
    return { status: "started" }
  }

  cancelIndex(): boolean {
    if (!this.run) return false
    this.run.handle.cancel()
    return true
  }

  /**
   * Wait until the current run ends, `ms` pass or `signal` aborts, calling `onProgress` on
   * each progress update meanwhile. True if the run ended.
   */
  async waitIndex(ms: number, signal: AbortSignal, onProgress: (p: IndexProgress) => void): Promise<boolean> {
    const run = this.run
    if (!run) return true
    this.listeners.add(onProgress)
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort = () => {}
    try {
      return await Promise.race([
        run.done.then(() => true),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms))),
        new Promise<boolean>((r) => {
          onAbort = () => r(false)
          signal.addEventListener("abort", onAbort, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      this.listeners.delete(onProgress)
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer)
    const run = this.run
    if (run) {
      run.handle.cancel()
      await Promise.race([run.done, new Promise((r) => setTimeout(r, 5000))])
      run.handle.kill()
    }
    this.client.close()
    this.db?.close()
  }
}

/* ------------------------------------------------------------- helpers -- */

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null)

/** Kinds whose text is split into pages, slides, sheets or sections. */
const PAGED_KINDS = new Set<Kind>(["pdf", "slides", "sheet", "ebook"])

/** What a page break separates in a file of this kind. */
function pageWord(kind: Kind): string {
  return kind === "pdf" ? "page" : kind === "slides" ? "slide" : kind === "sheet" ? "sheet" : "section"
}

/** The page holding line `n`, from the lines where each page starts (none: not paged). */
function pageOf(pageStarts: number[], n: number): number | undefined {
  if (!pageStarts.length) return undefined
  let lo = 0
  let hi = pageStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pageStarts[mid]! <= n) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** Quote a filter value that has spaces, as the query syntax expects (`in:"~/My Folder"`). */
function filterValue(v: string): string {
  if (v.includes('"')) throw new ToolError(`filter values cannot contain double quotes: ${v}`)
  return /\s/.test(v) ? `"${v}"` : v
}

function oneWord(name: string, v: string): string {
  if (/\s/.test(v.trim())) throw new ToolError(`${name} cannot contain spaces: "${v}"`)
  return v.trim()
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [])

/** The query zsearch runs for search tool arguments: the query text plus filters in its syntax. */
export function buildQuery(args: Record<string, unknown>): string {
  const parts: string[] = []
  const text = String(args.query ?? "").trim()
  const types = strings(args.type)
  for (const t of [...types, ...strings(args.exclude_type)]) {
    if (!KIND_ALIASES[t.toLowerCase()]) throw new ToolError(`unknown type "${t}" (use one of: ${Object.keys(KIND_ALIASES).join(", ")})`)
  }
  if (types.length) parts.push(`type:${types.join(",")}`)
  const notTypes = strings(args.exclude_type)
  if (notTypes.length) parts.push(`-type:${notTypes.join(",")}`)
  const exts = strings(args.ext).map((e) => oneWord("ext", e).replace(/^\*?\./, ""))
  if (exts.length) parts.push(`ext:${exts.join(",")}`)
  for (const f of strings(args.folder)) parts.push(`in:${filterValue(f)}`)
  if (typeof args.path === "string" && args.path.trim()) parts.push(`path:${oneWord("path", args.path)}`)
  if (typeof args.size === "string" && args.size.trim()) parts.push(`size:${oneWord("size", args.size)}`)
  if (typeof args.modified === "string" && args.modified.trim()) parts.push(`mtime:${oneWord("modified", args.modified)}`)
  if (typeof args.after === "string" && args.after.trim()) parts.push(`after:${oneWord("after", args.after)}`)
  if (typeof args.before === "string" && args.before.trim()) parts.push(`before:${oneWord("before", args.before)}`)
  let query = text
  if (args.regex === true && text) query = `re:${text.replace(/^\/(.*)\/$/, "$1")}`
  return [query, ...parts].filter(Boolean).join(" ")
}

function hitLocation(kind: Kind, line: number, page: number, paged: boolean): string {
  return paged && page > 0 ? `${pageWord(kind)} ${page}, line ${line}` : `line ${line}`
}

function describeHit(h: SearchHit): string {
  const bits = [h.isDir ? "folder" : h.kind, ...(h.isDir ? [] : [formatBytes(h.size)]), `modified ${formatDate(h.mtime)}`]
  if (h.matchCount > 0) bits.push(`${formatCount(h.matchCount)} ${h.matchCount === 1 ? "match" : "matches"}`)
  return bits.join(" · ")
}

/** Status of the index, for index_status, update_index and the status resource. */
async function indexState(host: Host, opts: { errors?: number } = {}) {
  const config = host.reloadConfig()
  const { stats } = await host.stats()
  const period = config.autoRefreshMinutes * 60_000
  const other = host.run ? null : lockHolder(host.paths.lock)
  const p = host.run?.progress
  const indexing = host.run
    ? {
        by: "this server" as const,
        reason: host.run.reason,
        phase: p?.phase ?? "starting",
        scanned: p?.scanned ?? 0,
        contentDone: p?.contentDone ?? 0,
        contentTotal: p?.contentTotal ?? 0,
        percent: p && p.phase === "content" && p.contentTotal ? Math.floor((p.contentDone / p.contentTotal) * 100) : null,
        current: p?.current ?? "",
        elapsedMs: Date.now() - host.run.startedAt,
      }
    : other !== null
      ? { by: "another process" as const, pid: other }
      : null
  const last = host.lastRun
  return {
    version: host.version,
    indexPath: host.paths.db,
    configPath: host.paths.configFile,
    roots: config.roots,
    indexedRoots: stats.roots,
    files: stats.files,
    folders: stats.folders,
    withText: stats.withContent,
    textBytes: stats.contentBytes,
    skipped: stats.skipped,
    unreadable: stats.errors,
    pending: stats.pending,
    indexBytes: stats.dbBytes,
    lastIndexedAt: iso(stats.lastIndexedAt),
    lastDurationMs: stats.lastDurationMs,
    stale: stats.lastIndexedAt === null || (period > 0 && Date.now() - stats.lastIndexedAt > period),
    contentEnabled: config.content.enabled,
    pdftotext: pdftotextPath() !== null,
    indexing,
    lastRun: last
      ? {
          status: last.status,
          finishedAt: iso(last.finishedAt)!,
          ...(last.progress
            ? { scanned: last.progress.scanned, added: last.progress.added, updated: last.progress.updated, removed: last.progress.removed, unreadable: last.progress.contentErrors, elapsedMs: last.progress.elapsedMs }
            : {}),
          ...(last.error ? { error: last.error } : {}),
        }
      : null,
    ...(opts.errors ? { unreadableFiles: await host.unreadable(opts.errors) } : {}),
  }
}

type IndexState = Awaited<ReturnType<typeof indexState>>

function describeState(s: IndexState): string {
  const out: string[] = []
  out.push(`Folders: ${s.roots.join(", ")}${JSON.stringify([...s.indexedRoots].sort()) !== JSON.stringify(s.roots.map((r) => resolvePath(r)).sort()) && s.indexedRoots.length ? ` (the index was built from ${s.indexedRoots.map(tildify).join(", ")}; update_index applies the new folders)` : ""}`)
  out.push(`Index: ${formatCount(s.files)} files and ${formatCount(s.folders)} folders, ${formatCount(s.withText)} with text (${formatBytes(s.textBytes)}), ${formatBytes(s.indexBytes)} on disk.`)
  if (s.skipped || s.unreadable || s.pending) out.push(`Contents: ${formatCount(s.skipped)} skipped (binary, too large or empty), ${formatCount(s.unreadable)} unreadable, ${formatCount(s.pending)} not read yet.`)
  if (!s.contentEnabled) out.push("Reading file contents is turned off (content.enabled): only names are searched.")
  out.push(s.lastIndexedAt ? `Last updated: ${formatDate(Date.parse(s.lastIndexedAt))}${s.lastDurationMs ? ` (took ${formatDuration(s.lastDurationMs)})` : ""}${s.stale ? ", due for an update" : ""}.` : "The index has never been completed: call update_index to build it.")
  if (s.indexing?.by === "this server") {
    const i = s.indexing
    out.push(`Indexing now (${i.reason === "auto" ? "automatic update" : "requested"}): ${i.phase === "content" ? `reading contents, ${formatCount(i.contentDone)} of ${formatCount(i.contentTotal)} files${i.percent !== null ? ` (${i.percent}%)` : ""}` : i.phase === "cleanup" ? "removing deleted files" : `scanning, ${formatCount(i.scanned)} items so far`}, for ${formatDuration(i.elapsedMs)}.`)
  } else if (s.indexing) out.push(`Another zsearch process (pid ${s.indexing.pid}) is updating the index.`)
  if (s.lastRun) {
    const r = s.lastRun
    out.push(
      r.status === "done" && r.added !== undefined
        ? `Last run here: done in ${formatDuration(r.elapsedMs ?? 0)}, ${formatCount(r.scanned ?? 0)} items scanned, ${formatCount(r.added)} new, ${formatCount(r.updated ?? 0)} changed, ${formatCount(r.removed ?? 0)} removed${r.unreadable ? `, ${formatCount(r.unreadable)} unreadable` : ""}.`
        : `Last run here: ${r.status}${r.error ? ` (${r.error})` : ""}.`,
    )
  }
  if (s.unreadableFiles) {
    out.push(s.unreadableFiles.length ? "Unreadable files:" : "No unreadable files.")
    for (const f of s.unreadableFiles) out.push(`  ${f.path}: ${f.reason}`)
  }
  return out.join("\n")
}

/* --------------------------------------------------------------- schemas -- */

const str = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "string", description, ...extra })
const strList = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description })
const int = (description: string, minimum: number, maximum: number, def?: number): JsonSchema => ({ type: "integer", description, minimum, maximum, ...(def !== undefined ? { default: def } : {}) })
const bool = (description: string, def?: boolean): JsonSchema => ({ type: "boolean", description, ...(def !== undefined ? { default: def } : {}) })
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false })
const loose = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required })
const nullable = (s: JsonSchema): JsonSchema => ({ ...s, type: [s.type as string, "null"] })

const KINDS = "folder, code, text, markdown, data, web, pdf, doc, sheet, slides, ebook, email, image, audio, video, archive, app, other"

const LINE_SCHEMA = loose({ line: { type: "integer" }, page: { type: "integer" }, text: { type: "string" } }, ["line", "text"])
const STATE_SCHEMA = loose(
  {
    roots: strList("Folders the settings say to index"),
    indexedRoots: strList("Folders the index was last built from"),
    files: { type: "integer" },
    folders: { type: "integer" },
    withText: { type: "integer" },
    textBytes: { type: "integer" },
    skipped: { type: "integer" },
    unreadable: { type: "integer" },
    pending: { type: "integer" },
    indexBytes: { type: "integer" },
    lastIndexedAt: nullable(str("When the last index run completed (ISO 8601)")),
    stale: bool("The index is older than autoRefreshMinutes, or was never completed"),
    indexing: { type: ["object", "null"], description: "The index run in progress, if any" },
    lastRun: { type: ["object", "null"], description: "How the last run started by this server ended" },
  },
  ["roots", "files", "folders", "lastIndexedAt", "stale", "indexing"],
)

/* ----------------------------------------------------------------- tools -- */

/** Settable keys, dotted: every leaf of the settings. */
export const CONFIG_KEYS: string[] = (() => {
  const out: string[] = []
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) walk(v as Record<string, unknown>, `${prefix}${k}.`)
      else out.push(prefix + k)
    }
  }
  walk(defaultConfig() as unknown as Record<string, unknown>, "")
  return out
})()

/** Settings that change what is indexed, so they take effect at the next index update. */
const INDEX_KEYS = /^(roots|exclude|namesOnly|includeHidden|respectGitignore|followSymlinks|oneFileSystem|cloudContent|content\.)/

/** Checks beyond the value's type, as an error message (null: fine). */
const CONFIG_RULES: Record<string, (v: unknown) => string | null> = {
  defaultMode: (v) => (v === "find" || v === "fuzzy" ? null : 'must be "find" or "fuzzy"'),
  indexLoad: (v) => (Number.isInteger(v) && (v as number) >= 10 && (v as number) <= 100 ? null : "must be a whole number from 10 to 100 (percent)"),
  workers: (v) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 64 ? null : "must be a whole number from 0 (automatic) to 64"),
  autoRefreshMinutes: (v) => ((v as number) >= 0 ? null : "must be 0 (off) or more"),
  "content.maxDocumentMB": (v) => ((v as number) > 0 ? null : "must be more than 0"),
  "content.maxTextMB": (v) => ((v as number) > 0 ? null : "must be more than 0"),
  "content.maxChars": (v) => (Number.isInteger(v) && (v as number) > 0 ? null : "must be a whole number above 0"),
}

function getKey(config: Config, key: string): unknown {
  return key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], config)
}

/** A copy of `config` with `key` set to `raw`, converted to the setting's type and checked. */
export function withSetting(config: Config, key: string, raw: unknown): Config {
  if (!CONFIG_KEYS.includes(key)) throw new ToolError(`unknown setting "${key}" (settings: ${CONFIG_KEYS.join(", ")})`)
  const cur = getKey(config, key)
  let value: unknown = raw
  if (Array.isArray(cur)) {
    if (typeof raw === "string") value = raw.split(",").map((s) => s.trim()).filter(Boolean)
    if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) throw new ToolError(`${key} expects a list of strings`)
    value = (value as string[]).map((s) => s.trim()).filter(Boolean)
  } else if (typeof cur === "boolean") {
    if (typeof raw === "string" && /^(true|false|1|0|yes|no|on|off)$/i.test(raw)) value = /^(true|1|yes|on)$/i.test(raw)
    if (typeof value !== "boolean") throw new ToolError(`${key} expects true or false`)
  } else if (typeof cur === "number") {
    if (typeof raw === "string" && raw.trim() !== "") value = Number(raw)
    if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolError(`${key} expects a number`)
  } else if (typeof cur === "string") {
    if (typeof raw !== "string") throw new ToolError(`${key} expects a string`)
  }
  const problem = CONFIG_RULES[key]?.(value)
  if (problem) throw new ToolError(`${key} ${problem}`)
  const next = structuredClone(config)
  const parts = key.split(".")
  const parent = parts.slice(0, -1).reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, next as unknown as Record<string, unknown>)
  parent[parts.at(-1)!] = value
  return next
}

export function tools(host: Host): Tool[] {
  const search: Tool = {
    name: "search",
    title: "Search files",
    description: `Search the user's indexed files by name and by the text inside them (PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, e-mail, notebooks, code, Markdown, plain text).

Mode "find" (default) finds the exact text of the query in file contents and paths: several words are one piece of text, in that order; it ignores case unless the query has a capital letter. Set regex to treat the query as a JavaScript regular expression. Mode "fuzzy" matches file paths fzf-style and forgives typos: use it for a file name you only half remember.

Filters can be given as arguments, or written in the query in zsearch's syntax: type:pdf, ext:docx, in:~/Documents, path:2024, size:>5mb, mtime:<7d, after:2024-01-01, before:2024-06, limit:50, is:image. A query of filters alone lists matching files, newest first; an empty query lists recently opened and modified files.

Each result gives the file's absolute path, kind, size, modification time and its best matching lines with line numbers (and the page, slide or sheet for paged documents). Use read_file to read more of a file.`,
    inputSchema: obj({
      query: str("Text to find, or a regular expression with regex: true. May include filters (type:pdf mtime:<30d). Empty: recent files.", { default: "" }),
      mode: str('"find" (exact text, default) or "fuzzy" (typo-tolerant file names)', { enum: ["find", "fuzzy"], default: "find" }),
      regex: bool("Treat the query as a regular expression (find mode)", false),
      type: strList(`Only these kinds of file. Kinds: ${KINDS}. Aliases: docs (all documents), spreadsheet, presentation, photo, music, notes, word, excel, powerpoint…`),
      exclude_type: strList("Leave out these kinds of file"),
      ext: strList('Only these file extensions, e.g. ["pdf", "docx"]'),
      folder: strList('Only inside these folders (absolute, ~/…, or relative to the home folder), e.g. ["~/Documents/Taxes"]'),
      path: str("Only files whose path contains this text"),
      modified: str('Modification time: "<7d" (within 7 days), ">1y" (older than a year), "today", "yesterday", "2024", "2024-06", "2024-06-01". Units: s, min, h, d, w, mo, y'),
      after: str("Modified on or after this date (2024-01-01, 2024-06 or 2024)"),
      before: str("Modified before this date (2024-01-01, 2024-06 or 2024)"),
      size: str('File size: ">5mb", "<100k", "1mb..10mb"'),
      limit: int("Results to return", 1, 200, 20),
      offset: int("Results to skip, to page through many results", 0, 800, 0),
      lines_per_file: int("Matching lines to show per file", 0, 8, 3),
    }),
    outputSchema: loose(
      {
        query: str("The query zsearch ran, with the filters in its syntax"),
        mode: str("The mode the query ran in"),
        strategy: str("How the query was run"),
        total: { type: "integer", description: "Matching files found (at least)" },
        offset: { type: "integer" },
        partial: bool("The time limit stopped a full scan early: there may be more matches"),
        notice: str("A warning about the query, such as a filter that was not understood"),
        hits: {
          type: "array",
          items: loose(
            {
              path: str("Absolute path"),
              kind: str("Kind of file"),
              isDir: { type: "boolean" },
              size: { type: "integer" },
              modified: str("Modification time (ISO 8601)"),
              matchCount: { type: "integer" },
              matchedBy: strList("What matched: name, content"),
              lines: { type: "array", items: LINE_SCHEMA },
            },
            ["path", "kind", "isDir", "size", "modified", "lines"],
          ),
        },
      },
      ["query", "mode", "total", "hits"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args) {
      host.reloadConfig()
      const query = buildQuery(args)
      const mode = args.mode as Mode
      const limit = args.limit as number
      const offset = args.offset as number
      const perFile = args.lines_per_file as number
      const res = await host.search(query, mode, offset + limit)
      if (res.error) throw new ToolError(`search failed: ${res.error}`)
      const hits = res.hits.slice(offset, offset + limit)
      const structured = {
        query,
        mode: res.resolved,
        strategy: res.strategy,
        total: res.total,
        offset,
        partial: res.partial,
        ...(res.notice ? { notice: res.notice } : {}),
        hits: hits.map((h) => {
          const paged = PAGED_KINDS.has(h.kind) || h.lines.some((l) => l.page > 1)
          return {
            path: h.path,
            kind: h.kind,
            isDir: h.isDir,
            size: h.size,
            modified: iso(h.mtime)!,
            matchCount: h.matchCount,
            matchedBy: h.sources,
            lines: h.lines.slice(0, perFile).map((l) => ({ line: l.line, ...(paged ? { page: l.page } : {}), text: l.text })),
          }
        }),
      }
      const out: string[] = []
      if (!hits.length) {
        out.push(res.hits.length ? `No results past the first ${formatCount(res.hits.length)} for ${JSON.stringify(query)}.` : `No files match ${JSON.stringify(query)}.`)
        const { stats } = await host.stats()
        if (stats.lastIndexedAt === null && stats.files === 0) out.push("The index is empty: call update_index to build it (it indexes ~/Documents and ~/Downloads unless you give other folders).")
        else if (!res.hits.length) out.push(`Only these folders are indexed: ${host.config.roots.join(", ")}. Try fewer words, mode "fuzzy" for names, or fewer filters.`)
      } else {
        const range = offset || res.total > hits.length ? `, showing ${offset + 1}–${offset + hits.length}` : ""
        out.push(`${formatCount(res.total)} ${res.total === 1 ? "result" : "results"} for ${JSON.stringify(query)}${range} (${res.strategy}, ${formatDuration(res.elapsedMs)}):`)
        hits.forEach((h, i) => {
          const s = structured.hits[i]!
          out.push("", `${offset + i + 1}. ${h.path}${h.isDir ? "/" : ""}`, `   ${describeHit(h)}`)
          for (const l of s.lines) out.push(`   ${hitLocation(h.kind, l.line, l.page ?? 0, l.page !== undefined)}: ${l.text}`)
        })
        if (res.total > offset + hits.length) out.push("", `More results: call again with offset ${offset + hits.length}, or narrow the search.`)
      }
      if (res.partial) out.push("", "The search stopped at its time limit, so there may be more matches.")
      if (res.notice) out.push("", `Note: ${res.notice}`)
      return { text: out.join("\n"), structured }
    },
  }

  const readFile: Tool = {
    name: "read_file",
    title: "Read a file's text",
    description: `Read the text of an indexed file, with line numbers. For PDFs, Office documents, e-books, e-mail and notebooks this is the text zsearch extracted (with page, slide or sheet numbers); for code and text files it is the file itself. For a folder it lists the entries.

Give query (the same text or regex as in search) to mark the matching lines and start at the first match, or matches_only to get just the matching lines with some context. Use line and lines to read a particular part; long files take several calls. Only files in the index can be read.`,
    inputSchema: obj(
      {
        path: str("Absolute path of the file (or ~/…), as search returned it"),
        query: str("Text or regex (/…/ or with regex: true) whose matches to mark and jump to"),
        regex: bool("Treat query as a regular expression", false),
        mode: str('How query matches: "find" (exact text, default) or "fuzzy" (its words, typo-tolerant)', { enum: ["find", "fuzzy"], default: "find" }),
        line: int("First line to return (default: the first match, or line 1)", 1, 100_000_000),
        lines: int("Lines to return", 1, MAX_READ_LINES, 200),
        matches_only: bool("Return only the lines matching query, each with context lines around it", false),
        context: int("Context lines around each match with matches_only", 0, 20, 2),
      },
      ["path"],
    ),
    outputSchema: loose(
      {
        path: str("Absolute path"),
        kind: str("Kind of file"),
        isDir: { type: "boolean" },
        size: { type: "integer" },
        modified: str("Modification time (ISO 8601)"),
        source: str("Where the text came from: index (extracted text), disk (read now) or none"),
        totalLines: { type: "integer" },
        pages: { type: "integer", description: "Pages, slides or sheets, for paged documents" },
        matchLines: { type: "array", items: { type: "integer" }, description: "Lines matching the query (up to 2000)" },
        lines: { type: "array", items: loose({ line: { type: "integer" }, page: { type: "integer" }, text: { type: "string" }, match: { type: "boolean" } }, ["line", "text"]) },
        message: str("Why there is no text, when there is none"),
        more: bool("More lines follow the last one returned"),
      },
      ["path", "kind", "totalLines", "lines"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args) {
      host.reloadConfig()
      const found = await host.findFile(String(args.path))
      if (!found) {
        const abs = resolvePath(String(args.path).trim())
        const isDir = existsSync(abs) && statSync(abs).isDirectory()
        throw new ToolError(
          isDir && host.config.roots.some((r) => resolvePath(r) === abs)
            ? `${abs} is an indexed folder itself: use search with folder: ["${tildify(abs)}"] (and an empty query) to list what is in it.`
            : existsSync(abs)
            ? `${abs} is not in the index. zsearch reads only indexed files (folders: ${host.config.roots.join(", ")}); it may be excluded, hidden, or new since the last update_index.`
            : `${abs} does not exist and is not in the index. Use search to find the file's path.`,
        )
      }
      let raw = String(args.query ?? "").trim()
      if (raw && args.regex === true) raw = `re:${raw.replace(/^\/(.*)\/$/, "$1")}`
      const mode = args.mode as Mode
      const count = args.lines as number
      const matchesOnly = args.matches_only === true
      if (matchesOnly && !raw) throw new ToolError("matches_only needs a query")
      // A preview of `count` lines starts a quarter of them above its focus line.
      const start = args.line as number | undefined
      const pv = matchesOnly
        ? await host.preview(found.id, raw, mode, 1, 1_000_000)
        : await host.preview(found.id, raw, mode, start !== undefined ? start + Math.floor(count / 4) : undefined, count)
      const matchSet = new Set(pv.matchLines)
      let lines = pv.lines
      let more = lines.length > 0 && lines.at(-1)!.n < pv.totalLines
      if (matchesOnly) {
        const ctx = args.context as number
        const keep = new Set<number>()
        for (const m of pv.matchLines) for (let n = Math.max(1, m - ctx); n <= m + ctx; n++) keep.add(n)
        const kept = pv.lines.filter((l) => keep.has(l.n))
        lines = kept.slice(0, count)
        more = kept.length > count
      } else if (start !== undefined && start > pv.totalLines && pv.totalLines > 0) {
        throw new ToolError(`line ${start} is past the end: the file has ${formatCount(pv.totalLines)} lines`)
      }
      const paged = pv.pageStarts.length > 1
      const structured = {
        path: pv.path,
        kind: pv.kind,
        isDir: pv.isDir,
        size: pv.size,
        modified: iso(pv.mtime)!,
        source: pv.source,
        totalLines: pv.totalLines,
        ...(paged ? { pages: pv.pageStarts.length } : {}),
        ...(raw ? { matchLines: pv.matchLines } : {}),
        lines: lines.map((l) => ({ line: l.n, ...(paged ? { page: pageOf(pv.pageStarts, l.n) } : {}), text: l.text, ...(matchSet.has(l.n) ? { match: true } : {}) })),
        ...(pv.message ? { message: pv.message } : {}),
        more,
      }
      const head = `${pv.path}${pv.isDir ? "/" : ""} — ${pv.isDir ? "folder" : `${pv.kind} · ${formatBytes(pv.size)}`} · modified ${formatDate(pv.mtime)}`
      const out = [head]
      if (pv.message && !lines.length) {
        out.push(pv.message[0]!.toUpperCase() + pv.message.slice(1) + ".")
        return { text: out.join("\n"), structured }
      }
      if (pv.isDir) out.push(`${formatCount(pv.totalLines)} entries${lines.length < pv.totalLines ? `, the first ${formatCount(lines.length)}` : ""}:`)
      else {
        const what = paged ? `${formatCount(pv.totalLines)} lines, ${pv.pageStarts.length} ${pageWord(pv.kind)}s` : `${formatCount(pv.totalLines)} lines`
        out.push(`${what}${pv.source === "index" ? " (text extracted by zsearch)" : ""}.`)
      }
      if (raw) {
        const shown = pv.matchLines.slice(0, 30).join(", ")
        out.push(pv.matchLines.length ? `${formatCount(pv.matchLines.length)} matching ${pv.matchLines.length === 1 ? "line" : "lines"} for ${JSON.stringify(raw)}: ${shown}${pv.matchLines.length > 30 ? ", …" : ""}` : `No lines match ${JSON.stringify(raw)}.`)
      }
      if (lines.length) {
        const width = String(lines.at(-1)!.n).length
        out.push(matchesOnly ? "" : `Lines ${lines[0]!.n}–${lines.at(-1)!.n}${pv.isDir ? "" : " (> marks a match)"}:`)
        let prev = 0
        let page = 0
        for (const l of lines) {
          const pg = paged ? pageOf(pv.pageStarts, l.n)! : 0
          if (paged && pg !== page) {
            out.push(`--- ${pageWord(pv.kind)} ${pg} ---`)
            page = pg
          } else if (matchesOnly && prev && l.n > prev + 1) out.push("…")
          prev = l.n
          out.push(pv.isDir ? l.text : `${matchSet.has(l.n) ? ">" : " "}${String(l.n).padStart(width)}  ${l.text}`)
        }
        const last = lines.at(-1)!.n
        if (!matchesOnly && last < pv.totalLines) out.push(`… ${formatCount(pv.totalLines - last)} more lines: call again with line ${last + 1}.`)
        if (matchesOnly && more) out.push(`… more matches: call again with a larger lines, or read from line ${last + 1}.`)
      }
      return { text: out.join("\n"), structured }
    },
  }

  const status: Tool = {
    name: "index_status",
    title: "Index status",
    description: "What zsearch has indexed: the folders, how many files (and how many with readable text), when the index was last updated, and whether indexing is running now, with its progress. Set errors to list files whose contents could not be read, with the reason.",
    inputSchema: obj({
      errors: bool("Also list the files that could not be read", false),
      errors_limit: int("Unreadable files to list at most", 1, 1000, 100),
    }),
    outputSchema: STATE_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args) {
      const s = await indexState(host, { errors: args.errors === true ? (args.errors_limit as number) : 0 })
      return { text: describeState(s), structured: s }
    },
  }

  const update: Tool = {
    name: "update_index",
    title: "Update the index",
    description: `Update the index in the background: find new, changed and deleted files and read the contents of new and changed ones. Give roots to index other folders (this replaces the folders in the settings, like \`zsearch index <folders>\`). Set rebuild to start from an empty index. Set wait_seconds to wait for it to finish (with progress notifications); otherwise it returns at once and index_status shows progress. Search works while indexing runs, on what is indexed so far.`,
    inputSchema: obj({
      roots: strList('Folders to index from now on, e.g. ["~/Documents", "~/code"] or ["~"] for the whole home folder'),
      rebuild: bool("Throw away the index and build it again from scratch", false),
      wait_seconds: int("Wait this long for indexing to finish (0: return at once)", 0, 600, 0),
    }),
    outputSchema: loose({ status: str("started, running (already), busy (another process is indexing), done, cancelled or error"), ...STATE_SCHEMA.properties }, ["status", "files", "indexing"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(args, ctx) {
      let config = host.reloadConfig()
      const roots = strings(args.roots)
      if (roots.length) {
        const resolved = roots.map((r) => resolvePath(r))
        const missing = resolved.filter((r) => !existsSync(r) || !statSync(r).isDirectory())
        if (missing.length) throw new ToolError(`not a folder: ${missing.join(", ")}`)
        config = { ...config, roots: resolved.map(tildify) }
        saveConfig(config)
        host.applyConfig(config)
      }
      const started = host.startIndex(args.rebuild === true)
      if (started.status === "busy") {
        const s = await indexState(host)
        return { text: `Another zsearch process (pid ${started.pid}) is updating the index; it was not started again.\n${describeState(s)}`, structured: { status: "busy", ...s } }
      }
      let status: string = started.status
      const wait = args.wait_seconds as number
      if (wait > 0) {
        const ended = await host.waitIndex(wait * 1000, ctx.signal, (p) => {
          const total = p.phase === "content" || p.phase === "cleanup" || p.phase === "done" ? p.scanned + p.contentTotal : undefined
          ctx.progress(p.scanned + p.contentDone, total, progressLine(p))
        })
        if (ended) status = host.lastRun?.status ?? "done"
      }
      const s = await indexState(host)
      const lead =
        status === "started"
          ? `Indexing started${args.rebuild === true ? " from scratch" : ""} (${s.roots.join(", ")}).`
          : status === "running"
            ? "Indexing was already running; it carries on."
            : status === "done"
              ? "Indexing finished."
              : `Indexing ${status}.`
      const tail = status === "started" || status === "running" ? "\nSearch works meanwhile, on what is indexed so far. Call index_status to follow progress." : ""
      return { text: `${lead}\n${describeState(s)}${tail}`, structured: { status, ...s } }
    },
  }

  const cancel: Tool = {
    name: "cancel_index",
    title: "Stop indexing",
    description: "Stop the index update this server is running. What was indexed so far stays searchable; the next update carries on from there.",
    inputSchema: obj({}),
    outputSchema: loose({ stopped: bool("An index run was stopped"), message: str("What happened") }, ["stopped", "message"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(_args, ctx) {
      if (!host.run) {
        const other = lockHolder(host.paths.lock)
        const message = other !== null ? `Another zsearch process (pid ${other}) is indexing; stop it there (the app or terminal that started it).` : "No indexing is running."
        return { text: message, structured: { stopped: false, message } }
      }
      host.cancelIndex()
      await host.waitIndex(10_000, ctx.signal, () => {})
      const message = "Indexing stopped. What was indexed so far stays searchable."
      return { text: message, structured: { stopped: true, message } }
    },
  }

  const getConfig: Tool = {
    name: "get_config",
    title: "Show settings",
    description: `Show zsearch's settings (stored in ~/.config/zsearch/config.json and shared with the zsearch terminal app and Mac app), or one setting by its key. Keys: ${CONFIG_KEYS.join(", ")}.`,
    inputSchema: obj({ key: str("One setting to show (dotted, e.g. content.enabled); omit for all", { enum: CONFIG_KEYS }) }),
    outputSchema: loose({ path: str("The settings file"), config: { type: "object" }, key: str("The setting asked for"), value: { description: "Its value" } }, ["path"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args) {
      const config = host.reloadConfig()
      const path = host.paths.configFile
      if (typeof args.key === "string") {
        const value = getKey(config, args.key)
        return { text: `${args.key} = ${JSON.stringify(value)}`, structured: { path, key: args.key, value } }
      }
      return { text: `Settings (${path}):\n${JSON.stringify(config, null, 2)}`, structured: { path, config: config as unknown as Record<string, unknown> } }
    },
  }

  const setConfig: Tool = {
    name: "set_config",
    title: "Change a setting",
    description: `Change one of zsearch's settings. The settings are shared with the zsearch terminal app and Mac app.

- roots: folders to index; exclude: gitignore-style patterns or folders to skip; namesOnly: folders indexed by name only (lists; a comma-separated string works too)
- includeHidden, respectGitignore, followSymlinks, oneFileSystem, cloudContent (read iCloud/CloudStorage contents, may download files), content.enabled (read the text inside files): true or false
- content.maxDocumentMB, content.maxTextMB, content.maxChars: limits on what is read
- autoRefreshMinutes (0: off), workers (0: automatic), indexLoad (10–100, percent of the computer indexing may use)
- editor, defaultMode ("find" or "fuzzy"), preview

Settings that change what is indexed apply at the next update_index.`,
    inputSchema: obj(
      {
        key: str("The setting, dotted (e.g. includeHidden, content.maxTextMB)", { enum: CONFIG_KEYS }),
        value: { type: ["string", "number", "boolean", "array"], items: { type: "string" }, description: "The new value: a string, number, boolean, or list of strings" },
      },
      ["key", "value"],
    ),
    outputSchema: loose({ key: { type: "string" }, value: { description: "The value now set" }, previous: { description: "The value before" }, reindexNeeded: bool("The change applies at the next update_index") }, ["key", "value", "reindexNeeded"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(args) {
      const key = String(args.key)
      const before = host.reloadConfig()
      const next = withSetting(before, key, args.value)
      saveConfig(next)
      host.applyConfig(next)
      const value = getKey(next, key)
      const previous = getKey(before, key)
      const reindexNeeded = INDEX_KEYS.test(key) && JSON.stringify(value) !== JSON.stringify(previous)
      const notes: string[] = []
      if (key === "roots" || key === "namesOnly") {
        const missing = (value as string[]).filter((r) => !existsSync(resolvePath(r)))
        if (missing.length) notes.push(`These folders do not exist and will be skipped: ${missing.join(", ")}.`)
      }
      if (reindexNeeded) notes.push("Call update_index to apply this to the index.")
      return { text: [`${key} = ${JSON.stringify(value)} (was ${JSON.stringify(previous)})`, ...notes].join("\n"), structured: { key, value, previous, reindexNeeded } }
    },
  }

  return [search, readFile, status, update, cancel, getConfig, setConfig]
}

/* ------------------------------------------------------------- resources -- */

export const QUERY_SYNTAX = `# zsearch query syntax

## Modes
- **find** (default): the exact text you type, in file contents and paths. Several words are one piece of text, in that order. Smart case: case-sensitive only if the query has a capital letter. \`"Quotes"\` around the whole query are optional.
- **find with a regex**: wrap the query in slashes (\`/\\d{4}-\\d{2}/\`) or start it with \`re:\`. JavaScript regular expressions, over contents and paths.
- **fuzzy**: fzf-style matching of file paths that forgives typos (\`mian\` finds \`main.rs\`). Supports \`'exact\`, \`^prefix\`, \`suffix$\` and \`!exclude\`. \`f:…\` runs one query in fuzzy mode.

## Filters
| Filter | Example | Meaning |
| --- | --- | --- |
| \`ext:\` | \`ext:pdf,docx\` | File extension |
| \`type:\` / \`is:\` | \`type:doc\`, \`type:sheet\`, \`type:slides\`, \`type:code\`, \`type:image\`, \`type:folder\`, \`-type:pdf\` | Kind of file |
| \`in:\` | \`in:~/Documents\`, \`in:"~/My Folder"\` | Inside a folder (relative paths start at the home folder) |
| \`path:\` | \`path:2024\` | The path contains this text |
| \`size:\` | \`size:>5mb\`, \`size:<100k\`, \`size:1mb..10mb\` | File size |
| \`mtime:\` | \`mtime:<7d\`, \`mtime:>1y\`, \`mtime:today\`, \`mtime:2023\`, \`after:2024-01-01\`, \`before:2024-06\` | Modification time |
| \`limit:\` | \`limit:20\` | Number of results |

Kinds: ${KINDS}. Aliases: ${Object.keys(KIND_ALIASES).join(", ")}.

A query made only of filters lists the matching files, newest first. An empty query lists recently opened, then recently modified files.
`

function fileUri(path: string): string {
  return "file://" + path.split("/").map(encodeURIComponent).join("/")
}

/** A file's text for a resource read or a prompt: the extracted text, with page breaks marked. */
async function fileContents(host: Host, path: string, maxChars: number): Promise<ResourceContents> {
  const found = await host.findFile(path)
  if (!found) throw new RpcError(ErrorCode.ResourceNotFound, `not in the zsearch index: ${path}`)
  let text = host.storedText(found.id)
  if (text === null) {
    // No stored text: a small text file read from disk, a folder listing, or why there is none.
    const pv = await host.preview(found.id, "", "find", 1, 1_000_000)
    text = pv.lines.length ? pv.lines.map((l) => l.text).join("\n") : `(${pv.message ?? "no text"})`
  }
  if (text.includes("\f")) {
    const word = pageWord(found.kind)
    let page = 1
    text = `[${word} 1]\n` + text.replace(/\f/g, () => `\n\n[${word} ${++page}]\n`)
  }
  if (text.length > maxChars) text = text.slice(0, maxChars) + `\n\n[… truncated: ${formatCount(text.length - maxChars)} more characters; use read_file to read the rest]`
  return { uri: fileUri(found.path), mimeType: "text/plain", text }
}

/** Indexed file paths for completing `value`, best first. */
async function completePath(host: Host, value: string): Promise<string[]> {
  const res = await host.search(value.trim() ? `${value.trim()} -type:folder` : "", value.trim() ? "fuzzy" : "find", 20)
  return res.hits.filter((h) => !h.isDir).map((h) => h.path)
}

export function resources(host: Host): Resource[] {
  return [
    {
      uri: "zsearch://status",
      name: "status",
      title: "Index status",
      description: "What is indexed, how fresh the index is, and indexing progress (JSON)",
      mimeType: "application/json",
      read: async () => ({ uri: "zsearch://status", mimeType: "application/json", text: JSON.stringify(await indexState(host), null, 2) }),
    },
    {
      uri: "zsearch://config",
      name: "config",
      title: "Settings",
      description: "zsearch's settings (JSON)",
      mimeType: "application/json",
      read: async () => ({ uri: "zsearch://config", mimeType: "application/json", text: JSON.stringify(host.reloadConfig(), null, 2) }),
    },
    {
      uri: "zsearch://query-syntax",
      name: "query-syntax",
      title: "Query syntax",
      description: "Search modes and filters zsearch understands (Markdown)",
      mimeType: "text/markdown",
      read: async () => ({ uri: "zsearch://query-syntax", mimeType: "text/markdown", text: QUERY_SYNTAX }),
    },
  ]
}

export function templates(host: Host): ResourceTemplate[] {
  return [
    {
      uriTemplate: "file://{+path}",
      name: "file",
      title: "Indexed file",
      description: "The text of an indexed file (extracted text for PDFs and Office documents)",
      mimeType: "text/plain",
      async read(uri) {
        if (!uri.startsWith("file://")) return null
        let path: string
        try {
          path = decodeURIComponent(new URL(uri).pathname)
        } catch {
          throw new RpcError(ErrorCode.InvalidParams, `not a valid file URI: ${uri}`)
        }
        return fileContents(host, path, MAX_RESOURCE_CHARS)
      },
      complete: async (argument, value) => (argument === "path" ? completePath(host, value) : []),
    },
  ]
}

/* --------------------------------------------------------------- prompts -- */

export function prompts(host: Host): Prompt[] {
  return [
    {
      name: "find_files",
      title: "Find files",
      description: "Find files on this computer about something, and say what is in them",
      arguments: [{ name: "request", description: "What you are looking for, e.g. \"my 2024 tax return\" or \"notes from the Lisbon trip\"", required: true }],
      async get(args) {
        return {
          description: `Find files: ${args.request}`,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Find the files on my computer that match this request: ${args.request}

Use zsearch's search tool. Try the most distinctive words first, then synonyms, other spellings and filters (type, folder, modified) if the first searches miss; use mode "fuzzy" for file names. Read the most promising files with read_file to check them. Then list the files that match, best first, each with its full path, when it was modified, and a sentence on what it contains and why it matches.`,
              },
            },
          ],
        }
      },
    },
    {
      name: "summarize_file",
      title: "Summarize a file",
      description: "Summarize an indexed file (PDF, Office document, e-mail, code or text)",
      arguments: [{ name: "path", description: "Absolute path of the file", required: true }],
      async get(args) {
        let resource: ResourceContents
        try {
          resource = await fileContents(host, args.path!, PROMPT_CHARS)
        } catch (e) {
          throw new ToolError(e instanceof RpcError ? e.message : String(e))
        }
        return {
          description: `Summarize ${args.path}`,
          messages: [
            { role: "user", content: { type: "resource", resource } },
            { role: "user", content: { type: "text", text: `Summarize the file above (${args.path}): what it is, its main points, and any dates, amounts, names or action items in it.` } },
          ],
        }
      },
      complete: async (argument, value) => (argument === "path" ? completePath(host, value) : []),
    },
  ]
}

/* ------------------------------------------------------------------ main -- */

export async function mcp(version: string): Promise<number> {
  // stdout carries the protocol: anything else printed there would corrupt it.
  console.log = console.info = console.debug = console.error
  const host = new Host(version)
  const server = new McpServer(
    { name: "zsearch", title: "zsearch", version, instructions: INSTRUCTIONS },
    { tools: tools(host), resources: resources(host), templates: templates(host), prompts: prompts(host) },
    (line) => void process.stdout.write(line + "\n"),
  )
  host.log = (level, data) => server.log(level, data)
  host.startAutoRefresh()
  await serveStdio(server)
  await host.close()
  return 0
}
