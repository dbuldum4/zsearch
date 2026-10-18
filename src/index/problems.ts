/**
 * Indexing problems: the files whose contents search cannot find, or finds only in part, with
 * why in plain words and what would change it. Worked out from what the index records of each
 * file (`content_state` and `note`) and the current settings; no file's contents are read here.
 */
import type { Database } from "bun:sqlite"
import { statSync } from "node:fs"
import { type Config, resolvePath } from "../config.ts"
import { DOCUMENT_EXTS, OCR_EXTS, TEXT_EXPORT_EXTS, TEXTUAL_KINDS, TRANSCRIBE_EXTS } from "../kinds.ts"
import { cloudFolders, ocrToolPath, systemNamesOnly, transcriptionToolPath } from "../platform.ts"
import { ContentState, hasReadAt } from "./db.ts"
import { DATASET_NOTE } from "./datasets.ts"
import { crawlOptionsFor, pathPolicy, under } from "./policy.ts"
import { SECRET_NOTE } from "./secrets.ts"

/** In the order they are listed. */
export const PROBLEM_CATEGORIES = ["unreadable", "timeout", "transcription", "too-large", "no-text", "truncated", "dataset", "secret", "names-only", "cloud"] as const
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number]

export const PROBLEM_LABELS: Record<ProblemCategory, string> = {
  unreadable: "Could not be read",
  timeout: "Took too long to read",
  transcription: "Transcription failed",
  "too-large": "Too large to read",
  "no-text": "No text found",
  truncated: "Only partly searchable",
  dataset: "Dataset images, not read",
  secret: "Keys and passwords, name only",
  "names-only": "Names-only folders",
  cloud: "Cloud files, name only",
}

/** Reading these again may help. The others follow from settings or privacy rules, which a retry does not change. */
export const RETRYABLE_CATEGORIES: readonly ProblemCategory[] = ["unreadable", "timeout", "transcription", "no-text"]
const RETRYABLE = new Set(RETRYABLE_CATEGORIES)

/** Why a retry would not help, and what does. */
const NOT_RETRYABLE: Record<Exclude<ProblemCategory, "unreadable" | "timeout" | "transcription" | "no-text">, string> = {
  "too-large": "Raise the size limit (content.maxDocumentMB or content.maxTextMB), then update the index.",
  truncated: "Raise the text kept per file (content.maxChars), then update the index.",
  dataset: "Run `zsearch config set skipDatasetOcr false`, then update the index.",
  secret: "Keys and password files are never read: they stay findable by name.",
  "names-only": "Remove the folder from the names-only folders (namesOnly), then update the index.",
  cloud: "Turn on reading cloud folders (Settings › Index), or download the file, then update the index.",
}

export function isProblemCategory(v: unknown): v is ProblemCategory {
  return PROBLEM_CATEGORIES.includes(v as ProblemCategory)
}

/** A file whose contents search cannot find, or finds only in part. */
export interface IndexProblem {
  path: string
  size: number
  /** Milliseconds since 1970. */
  mtime: number
  category: ProblemCategory
  /** Why, in plain words, and what would change it. */
  reason: string
  /** The error as the reader reported it, for files that could not be read. */
  detail: string | null
  /** When its contents were last read (ms since 1970), if known. */
  at: number | null
  /** Reading the file again may help (see `retryProblems`). */
  retry: boolean
  /** The setting that decides it, if one does (a `zsearch config` key). */
  setting: string | null
}

export interface ProblemCount {
  category: ProblemCategory
  label: string
  count: number
  retry: boolean
}

export interface ProblemFilter {
  categories?: ProblemCategory[]
  /** Only paths containing this (ignoring ASCII case). */
  query?: string
}

export interface ProblemList {
  problems: IndexProblem[]
  /** Problems the filter matches, in all pages. */
  total: number
  /** Problems by category, with the filter's `query` but any category; only categories that have some. */
  categories: ProblemCount[]
}

/** Why a file's contents are, or are not, searchable. */
export interface Explanation {
  path: string
  /** What search finds of it: its text ("content"), its name only ("name"), or nothing ("none": not in the index). */
  searchable: "content" | "name" | "none"
  category: ProblemCategory | null
  reason: string
  detail: string | null
  retry: boolean
  setting: string | null
  at: number | null
}

export interface RetryResult {
  /** Files marked to be read again by the next index update. */
  retried: number
  /** Files asked for that a retry would not help, and why. */
  refused: { path: string; reason: string }[]
}

/** Files outside names-only folders checked at most for being cloud placeholders: a stat each. */
const OFFLINE_CHECKS = 20_000
const PAGE_MAX = 1000

interface Context {
  config: Config
  ocr: boolean
  speech: boolean
  /** Cloud folders, read by name only unless `cloudContent`. */
  cloud: string[]
  namesOnly: string[]
  /** System folders, read by name only when the whole disk is indexed: not listed, too many and no one's documents. */
  system: string[]
}

function context(config: Config): Context {
  return {
    config,
    ocr: config.content.enabled && config.content.ocr && ocrToolPath() !== null,
    speech: config.content.enabled && config.content.transcribe && transcriptionToolPath() !== null,
    cloud: config.cloudContent ? [] : cloudFolders(),
    namesOnly: config.namesOnly.map(resolvePath),
    system: config.roots.map(resolvePath).includes("/") ? systemNamesOnly() : [],
  }
}

/** Named parameters, so that a condition can be used twice in a statement. */
class Params {
  values: Record<string, string | number> = {}
  private n = 0
  add(v: string | number): string {
    const key = `p${this.n++}`
    this.values[key] = v
    return `$${key}`
  }
}

const list = (values: Iterable<string>) => [...values].map((v) => `'${v}'`).join(", ")
const DOCS = list(DOCUMENT_EXTS)
const IMAGES = list(OCR_EXTS)
const MEDIA = list(TRANSCRIBE_EXTS)
const rank = (c: ProblemCategory) => PROBLEM_CATEGORIES.indexOf(c)

/** `wantsContent` in SQL: the files whose contents the indexer reads with these settings. */
function wantedSql(c: Context): string {
  const parts = [`ext IN (${DOCS}, ${list(TEXT_EXPORT_EXTS)}, 'mbox')`, `kind IN (${list(TEXTUAL_KINDS)}, 'other')`]
  if (c.config.content.metadata) parts.push("kind = 'image'")
  if (c.ocr) parts.push(`ext IN (${IMAGES})`)
  if (c.speech) parts.push(`ext IN (${MEDIA})`)
  return `(${parts.join(" OR ")})`
}

/** Paths in any of these folders. */
function withinSql(dirs: string[], p: Params): string {
  if (!dirs.length) return "0"
  return `(${dirs
    .map((d) => {
      const base = d.endsWith("/") ? d : d + "/"
      // "0" sorts right after "/": the range holds exactly the paths under the folder.
      return `(path >= ${p.add(base)} AND path < ${p.add(base.slice(0, -1) + "0")})`
    })
    .join(" OR ")})`
}

interface Row {
  id: number
  path: string
  size: number
  mtime: number
  ext: string
  kind: string
  note: string | null
  at: number
  rank: number | null
}

/**
 * Every file with its problem category's rank in `PROBLEM_CATEGORIES`, or a null rank: files
 * with no problem, or none worth listing (binary files, empty text files). `offline` are the
 * ids of files found to be cloud placeholders.
 */
function problemsSql(db: Database, c: Context, p: Params, offline: number[]): string {
  const on = c.config.content.enabled
  const cloud = on ? withinSql(c.cloud, p) : "0"
  const names = on ? withinSql(c.namesOnly, p) : "0"
  const placeholders = on && offline.length ? `id IN (SELECT value FROM json_each(${p.add(JSON.stringify(offline))}))` : "0"
  return `SELECT id, path, size, mtime, ext, kind, note, ${hasReadAt(db) ? "read_at" : "0"} AS at, CASE
      WHEN content_state = ${ContentState.Error} AND ext IN (${MEDIA}) THEN ${rank("transcription")}
      WHEN content_state = ${ContentState.Error} AND (note LIKE '%timed out%' OR note LIKE '%deadline%') THEN ${rank("timeout")}
      WHEN content_state = ${ContentState.Error} THEN ${rank("unreadable")}
      WHEN content_state = ${ContentState.Skipped} AND note = 'too-large' THEN ${rank("too-large")}
      WHEN content_state = ${ContentState.Skipped} AND note IN ('empty', 'unsupported') AND (ext IN (${DOCS}) OR (kind = 'image' AND ext IN (${IMAGES})) OR ext IN (${MEDIA})) THEN ${rank("no-text")}
      WHEN content_state = ${ContentState.Indexed} THEN ${rank("truncated")}
      WHEN content_state = ${ContentState.Skipped} AND note = '${DATASET_NOTE}' THEN ${rank("dataset")}
      WHEN content_state = ${ContentState.Skipped} AND note = '${SECRET_NOTE}' THEN ${rank("secret")}
      WHEN content_state = ${ContentState.None} AND ${cloud} THEN ${rank("cloud")}
      WHEN content_state = ${ContentState.None} AND ${names} THEN ${rank("names-only")}
      WHEN content_state = ${ContentState.None} THEN ${rank("cloud")}
    END AS rank
    FROM files
    WHERE content_state IN (${ContentState.Error}, ${ContentState.Skipped})
      OR (content_state = ${ContentState.Indexed} AND note = 'truncated')
      OR (content_state = ${ContentState.None} AND is_dir = 0 AND ${wantedSql(c)} AND (${cloud} OR ${names} OR ${placeholders}))`
}

/** An online-only file (iCloud's "Optimize Mac Storage", say): the crawler reads it by name only. */
function isOffline(path: string): boolean {
  try {
    const st = statSync(path)
    return st.size > 4096 && st.blocks === 0
  } catch {
    return false
  }
}

/** Files read by name only outside names-only folders because they are cloud placeholders. */
function offlineFiles(db: Database, c: Context): number[] {
  if (!c.config.content.enabled) return []
  const p = new Params()
  const rows = db
    .query(`SELECT id, path FROM files WHERE content_state = ${ContentState.None} AND is_dir = 0 AND ${wantedSql(c)} AND NOT ${withinSql([...c.cloud, ...c.namesOnly, ...c.system], p)} LIMIT ${OFFLINE_CHECKS}`)
    .all(p.values) as { id: number; path: string }[]
  return rows.filter((r) => isOffline(r.path)).map((r) => r.id)
}

function filterSql(filter: ProblemFilter, p: Params, withCategories = true): string {
  let sql = "rank IS NOT NULL"
  const q = filter.query?.trim().toLowerCase()
  if (q) sql += ` AND instr(lower(path), ${p.add(q)}) > 0`
  if (withCategories && filter.categories) sql += ` AND rank IN (${filter.categories.map(rank).join(", ") || "-1"})`
  return sql
}

/** The query over problems, from the files it needs to stat (cloud placeholders) only when the filter wants them. */
function prepare(db: Database, config: Config, filter: ProblemFilter) {
  const c = context(config)
  const offline = !filter.categories || filter.categories.includes("cloud") ? offlineFiles(db, c) : []
  const p = new Params()
  return { c, p, inner: problemsSql(db, c, p, offline) }
}

function counts(db: Database, inner: string, where: string, values: Params["values"]): ProblemCount[] {
  const rows = db.query(`SELECT rank, count(*) AS n FROM (${inner}) WHERE ${where} GROUP BY rank ORDER BY rank`).all(values) as { rank: number; n: number }[]
  return rows.map((r) => {
    const category = PROBLEM_CATEGORIES[r.rank]!
    return { category, label: PROBLEM_LABELS[category], count: r.n, retry: RETRYABLE.has(category) }
  })
}

/** Problems by category: only categories that have some. */
export function problemCounts(db: Database, config: Config, filter: ProblemFilter = {}): ProblemCount[] {
  const { p, inner } = prepare(db, config, filter)
  return counts(db, inner, filterSql(filter, p), p.values)
}

/** A page of problems, by category and then path. */
export function listProblems(db: Database, config: Config, opts: ProblemFilter & { offset?: number; limit?: number } = {}): ProblemList {
  const { c, p, inner } = prepare(db, config, {})
  const categories = counts(db, inner, filterSql(opts, p, false), p.values)
  const wanted = opts.categories ? new Set(opts.categories) : null
  const total = categories.reduce((n, k) => n + (!wanted || wanted.has(k.category) ? k.count : 0), 0)
  const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(opts.limit ?? 100)))
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const rows = db.query(`SELECT * FROM (${inner}) WHERE ${filterSql(opts, p)} ORDER BY rank, path LIMIT ${limit} OFFSET ${offset}`).all(p.values) as Row[]
  return { problems: rows.map((r) => problemOf(r, c)), total, categories }
}

/** Every problem the filter matches, by category and then path. */
export function* eachProblem(db: Database, config: Config, filter: ProblemFilter = {}): Generator<IndexProblem> {
  const { c, p, inner } = prepare(db, config, filter)
  for (const r of db.query(`SELECT * FROM (${inner}) WHERE ${filterSql(filter, p)} ORDER BY rank, path`).iterate(p.values) as IterableIterator<Row>) yield problemOf(r, c)
}

function problemOf(r: Row, c: Context): IndexProblem {
  const category = PROBLEM_CATEGORIES[r.rank!]!
  const { reason, setting } = describe(category, r, c)
  const failed = category === "unreadable" || category === "timeout" || category === "transcription"
  return { path: r.path, size: r.size, mtime: r.mtime, category, reason, detail: failed ? r.note : null, at: r.at || null, retry: RETRYABLE.has(category), setting }
}

/** Raw reader errors, in plain words. The first that matches is used. */
const ERRORS: [RegExp, string][] = [
  [/^permission denied/i, "zsearch is not allowed to open it. Check the file's permissions, or give zsearch Full Disk Access in System Settings › Privacy & Security."],
  [/^file disappeared/i, "It was moved or deleted while it was being read."],
  [/password|encrypted/i, "It is password-protected or encrypted."],
  [/crashed|out of memory/i, "The reader stopped unexpectedly on it: the file may be damaged, or unusually complex."],
  [/budget|too many parts/i, "It is too big or too complex inside to read safely."],
  [/^OCR failed/i, "Text recognition (OCR) failed on it."],
  [/^pdftotext failed/i, "The PDF reader could not read it: it may be damaged."],
  [/unsupported|zip64/i, "It uses a variant of its format that zsearch cannot read."],
  [/^not (a|an) |unrecognised|no extractor|not a valid|missing/i, "It is not in the format its name suggests, or it is damaged."],
  [/corrupt|invalid|truncated|bad |eof/i, "It looks damaged."],
]

/** A reader's error message, in plain words. */
export function friendlyError(note: string | null): string {
  const raw = note ?? ""
  for (const [re, text] of ERRORS) if (re.test(raw)) return text
  return "It could not be read."
}

const isDoc = (ext: string) => DOCUMENT_EXTS.has(ext)
const isImage = (ext: string, kind: string) => kind === "image" && OCR_EXTS.has(ext)

function describe(category: ProblemCategory, r: { path: string; ext: string; kind: string; note: string | null }, c: Context): { reason: string; setting: string | null } {
  const content = c.config.content
  switch (category) {
    case "unreadable":
      return { reason: friendlyError(r.note), setting: null }
    case "timeout":
      return { reason: /^OCR/i.test(r.note ?? "") ? "Reading the text in its images (OCR) took too long, so it was stopped." : "Reading it took too long, so it was stopped: it may be very large or complex.", setting: null }
    case "transcription": {
      const note = r.note ?? ""
      if (/not ready|asset/i.test(note)) return { reason: "Apple's speech recognition was not ready: its language assets may still be downloading. It is tried again after an hour.", setting: null }
      if (/did not finish|deadline|timed out/i.test(note)) return { reason: "Transcribing it took too long, so it was stopped.", setting: null }
      return { reason: "It could not be transcribed: the recording may be damaged, or in an encoding Apple's speech recognition cannot read.", setting: null }
    }
    case "too-large":
      return isDoc(r.ext) || isImage(r.ext, r.kind)
        ? { reason: `It is larger than ${content.maxDocumentMB} MB, the limit for reading documents and images, so only its name is searchable.`, setting: "content.maxDocumentMB" }
        : { reason: `It is larger than ${content.maxTextMB} MB, the limit for reading text files, so only its name is searchable.`, setting: "content.maxTextMB" }
    case "no-text":
      if (TRANSCRIBE_EXTS.has(r.ext)) return { reason: "No speech was found in it.", setting: null }
      if (r.note === "unsupported") {
        return isImage(r.ext, r.kind)
          ? { reason: "Images are read only with text recognition (OCR), which is off or not available here.", setting: "content.ocr" }
          : { reason: "zsearch cannot read its text with the current settings.", setting: null }
      }
      if (r.ext === "pdf" && !c.ocr) return { reason: "No text was found in it. If it is a scan, turn on reading text in images and scanned PDFs (OCR) to read it.", setting: "content.ocr" }
      return { reason: isImage(r.ext, r.kind) ? "No text was found in this image." : "No text was found in it.", setting: null }
    case "truncated":
      return TRANSCRIBE_EXTS.has(r.ext)
        ? { reason: "Only part of the recording is searchable: transcripts stop after two hours, or when transcribing takes too long.", setting: null }
        : { reason: `Only the start of its text is searchable: it is longer than the ${content.maxChars.toLocaleString("en-US")} characters kept per file.`, setting: "content.maxChars" }
    case "dataset":
      return { reason: "It is in a folder of machine-made images (a dataset), so it is findable by name but not read with text recognition (OCR).", setting: "skipDatasetOcr" }
    case "secret":
      return { reason: "It looks like a key, certificate or password file. These are indexed by name only: their contents are never read, previewed or given to AI apps.", setting: null }
    case "names-only":
      return { reason: "It is in a folder set to names only, so only its name is searchable.", setting: "namesOnly" }
    case "cloud":
      return c.cloud.some((d) => under(r.path, d))
        ? { reason: "It is in iCloud Drive or another cloud folder, read by name only so that indexing does not download files. Turn on reading cloud folders in Settings › Index to read it.", setting: "cloudContent" }
        : { reason: "It is stored in the cloud only, not downloaded to this Mac, so it is indexed by name: reading it would download it. Download it in Finder, then update the index.", setting: null }
  }
}

const POLICY_DENIALS: Record<string, { reason: string; setting: string | null }> = {
  "outside indexed folders": { reason: "It is not in a folder zsearch indexes. Add its folder in Settings › Index.", setting: "roots" },
  "file unavailable": { reason: "It does not exist, or zsearch cannot reach it.", setting: null },
  "symbolic link target is outside indexed folders": { reason: "It is a symbolic link to a file outside the indexed folders.", setting: "followSymlinks" },
  "symbolic links are disabled": { reason: "It is reached through a symbolic link, and following links is off in Settings › Index.", setting: "followSymlinks" },
  "file is excluded by current settings": { reason: "Your settings leave it out: a folder or pattern to skip, a .gitignore or .zsearchignore rule, or hidden files left out.", setting: "exclude" },
}

interface FileRow {
  id: number
  path: string
  is_dir: number
  content_state: number
  note: string | null
  ext: string
  kind: string
}

/** Why a file's contents are, or are not, searchable ("Why can't it find this PDF?"). */
export function explainPath(db: Database, config: Config, path: string): Explanation {
  const c = context(config)
  const abs = resolvePath(path.trim())
  const base = { path: abs, category: null, detail: null, retry: false, at: null }
  const row = db.query("SELECT id, path, is_dir, content_state, note, ext, kind FROM files WHERE path = ?").get(abs) as FileRow | null
  if (!row) {
    const policy = pathPolicy(abs, crawlOptionsFor(config))
    const denied = !policy.allowed ? (POLICY_DENIALS[policy.reason ?? ""] ?? { reason: `It is not indexed: ${policy.reason}.`, setting: null }) : null
    return { ...base, searchable: "none", ...(denied ?? { reason: "It is not in the index yet: the next index update adds it.", setting: null }) }
  }
  const offline = row.content_state === ContentState.None && !row.is_dir && isOffline(abs) ? [row.id] : []
  const p = new Params()
  const found = db.query(`SELECT * FROM (${problemsSql(db, c, p, offline)}) WHERE rank IS NOT NULL AND id = ${p.add(row.id)}`).get(p.values) as Row | null
  if (found) {
    const problem = problemOf(found, c)
    const { size: _size, mtime: _mtime, ...rest } = problem
    return { ...rest, searchable: problem.category === "truncated" ? "content" : "name" }
  }
  return { ...base, ...searchableAnyway(row, c) }
}

/** Files with no listed problem: searchable, waiting, or not read for what they are. */
function searchableAnyway(row: FileRow, c: Context): { searchable: "content" | "name"; reason: string; setting: string | null } {
  const name = (reason: string, setting: string | null = null) => ({ searchable: "name" as const, reason, setting })
  if (row.is_dir) return name("Folders are found by name.")
  switch (row.content_state) {
    case ContentState.Indexed:
      return { searchable: "content", reason: "Its name and its text are searchable.", setting: null }
    case ContentState.Pending:
      return name("Its text has not been read yet: the index update going on, or the next one, reads it.")
    case ContentState.Skipped:
      if (row.note === "binary") return name("It holds binary data rather than text, so only its name is searchable.")
      if (row.note === "empty") return name("It is empty.")
      return name("zsearch cannot read its text with the current settings.")
    case ContentState.Error:
      return name(friendlyError(row.note))
  }
  const content = c.config.content
  if (!content.enabled) return name("Reading the text inside files is turned off in Settings › Index, so only names are searchable.", "content.enabled")
  if (c.system.some((d) => under(row.path, d))) return name("It is in a system folder, indexed by name only when the whole disk is indexed.")
  if (isImage(row.ext, row.kind) && !c.ocr) {
    return content.ocr
      ? name("Text in images is read with text recognition (OCR), which needs the Mac app's helper.")
      : name("Reading text in images and scanned PDFs (OCR) is turned off in Settings › Index.", "content.ocr")
  }
  if (TRANSCRIBE_EXTS.has(row.ext) && !c.speech) {
    return content.transcribe
      ? name("Speech is transcribed only by the Mac app, on macOS 26 or later.")
      : name("Transcribing speech in audio and video is turned off in Settings › Index.", "content.transcribe")
  }
  if (DOCUMENT_EXTS.has(row.ext) || TEXTUAL_KINDS.has(row.kind as never) || row.kind === "other") return name("Its text is read with the next index update.")
  return name("zsearch does not read the contents of this kind of file: it is found by its name, folder, size and date.")
}

/**
 * Have the next index update read these files again: those of a category, or at these paths.
 * Only problems a retry may help are marked (see `RETRYABLE`): keys, names-only and cloud files
 * are never read this way, nor files whose settings decide the outcome.
 */
export function retryProblems(db: Database, config: Config, target: { category?: ProblemCategory; paths?: string[] }): RetryResult {
  const { category, paths } = target
  if (category) {
    if (!RETRYABLE.has(category)) throw new Error(`Reading these files again would not change anything. ${NOT_RETRYABLE[category as keyof typeof NOT_RETRYABLE]}`)
    const { p, inner } = prepare(db, config, { categories: [category] })
    const ids = (db.query(`SELECT id FROM (${inner}) WHERE rank = ${rank(category)}`).values(p.values) as [number][]).map(([id]) => id)
    markPending(db, ids)
    return { retried: ids.length, refused: [] }
  }
  const wanted = [...new Set((paths ?? []).map((path) => resolvePath(path.trim())))]
  if (!wanted.length) return { retried: 0, refused: [] }
  const c = context(config)
  const p = new Params()
  const rows = db
    .query(`SELECT * FROM (${problemsSql(db, c, p, [])}) WHERE rank IS NOT NULL AND path IN (SELECT value FROM json_each(${p.add(JSON.stringify(wanted))}))`)
    .all(p.values) as Row[]
  const ids: number[] = []
  const retryable = new Set<string>()
  for (const r of rows) {
    if (!RETRYABLE.has(PROBLEM_CATEGORIES[r.rank!]!)) continue
    ids.push(r.id)
    retryable.add(r.path)
  }
  const refused = wanted.filter((path) => !retryable.has(path)).map((path) => {
    const e = explainPath(db, config, path)
    // Only problems a setting decides need the fix spelled out: the others' reasons already say what to do.
    const fix = e.category && !e.retry && e.setting ? NOT_RETRYABLE[e.category as keyof typeof NOT_RETRYABLE] : ""
    return { path, reason: e.category ? `${e.reason}${fix ? ` ${fix}` : ""}` : `Nothing to read again. ${e.reason}` }
  })
  markPending(db, ids)
  return { retried: ids.length, refused }
}

function markPending(db: Database, ids: number[]) {
  const mark = db.query(`UPDATE files SET content_state = ${ContentState.Pending}, note = NULL WHERE id = ?`)
  db.transaction(() => {
    for (const id of ids) mark.run(id)
  }).immediate()
}
