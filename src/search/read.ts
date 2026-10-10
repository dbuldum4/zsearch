/**
 * Reading an indexed file's text by line range, for `zsearch mcp`'s read_file tool and file
 * resources. Unlike the preview, which shows a window for the eye, this returns the text whole
 * (long lines included) and says exactly where to continue, so a caller can read every byte.
 */
import { readdirSync, readFileSync } from "node:fs"
import { decompressText } from "../index/db.ts"
import { decodeText, looksBinary } from "../index/extract/text.ts"
import type { Kind } from "../kinds.ts"
import type { SearchEngine } from "./engine.ts"
import type { Mode } from "./query.ts"
import { findLines, keywordLines, type LineMatch, splitLines } from "./snippet.ts"

export interface ReadOptions {
  /** First line to return (1-based). Default: a little above the first match, else 1. */
  line?: number
  /** Character of the first line to start at (1-based), to continue a line cut short. */
  column?: number
  /** Lines to return at most. */
  lines: number
  /** Characters of text to return at most, all lines together. */
  maxChars: number
  /** Only the lines matching the query, with `context` lines around each. */
  matchesOnly?: boolean
  context?: number
}

export interface ReadLine {
  n: number
  text: string
  /** Match ranges in `text`. */
  ranges: [number, number][]
  /** The character of the line `text` starts at, when not the first. */
  column?: number
  /** The line goes on past `text` (cut by `maxChars`). */
  cut?: boolean
}

export interface ReadResult {
  id: number
  path: string
  kind: Kind
  isDir: boolean
  size: number
  mtime: number
  /** Where the text came from: the index's extracted text, the file read now, or nowhere. */
  source: "index" | "disk" | "none"
  totalLines: number
  /** The line each page, slide or sheet starts at (only for paged documents). */
  pageStarts: number[]
  /** Lines with matches, in order (at most MAX_MATCH_LINES). */
  matchLines: number[]
  /** More lines match than `matchLines` holds. */
  matchesCapped: boolean
  lines: ReadLine[]
  /** Where to continue reading, if anything is left. */
  next: { line: number; column: number } | null
  /** Why there is no text. */
  message?: string
}

const MAX_MATCH_LINES = 100_000
const MATCH_BUDGET_MS = 2000

/** The line each page starts at, for text with form feeds between pages (empty otherwise). */
export function pageStartsOf(text: string): number[] {
  if (!text.includes("\f")) return []
  const starts = [1]
  let line = 1
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k)
    if (c === 10) line++
    else if (c === 12) starts.push(++line)
  }
  return starts
}

type Row = { id: number; path: string; kind: Kind; is_dir: number; size: number; mtime: number; content_state: number; note: string | null }

/**
 * Read the indexed file at `path` (absolute), ignoring case only when nothing matches exactly.
 * Null if it is not in the index. The lookup and the read see one snapshot of the index, so an
 * index rebuilt meanwhile cannot hand back another file's text.
 */
export function readIndexed(engine: SearchEngine, path: string, query: string, mode: Mode, opts: ReadOptions): ReadResult | null {
  // An invalid regex fails here, before anything is read.
  const pattern = query.trim() ? engine.matchPattern(query, mode) : null
  const db = engine.db
  return db.transaction((): ReadResult | null => {
    const cols = "id, path, kind, is_dir, size, mtime, content_state, note"
    let row = db.query(`SELECT ${cols} FROM files WHERE path = ?`).get(path) as Row | null
    if (!row) {
      const loose = db.query(`SELECT ${cols} FROM files WHERE path = ? COLLATE NOCASE LIMIT 2`).all(path) as Row[]
      row = loose.length === 1 ? loose[0]! : null
    }
    if (!row) return null
    const base: ReadResult = {
      id: row.id,
      path: row.path,
      kind: row.kind,
      isDir: row.is_dir === 1,
      size: row.size,
      mtime: row.mtime,
      source: "none",
      totalLines: 0,
      pageStarts: [],
      matchLines: [],
      matchesCapped: false,
      lines: [],
      next: null,
    }
    if (row.is_dir) return readFolder(base, engine.config.includeHidden, opts)
    let text: string | null = null
    const stored = db.query("SELECT data FROM content WHERE id = ?").get(row.id) as { data: Uint8Array } | null
    if (stored) {
      text = decompressText(stored.data)
      base.source = "index"
    } else if (row.size > 0 && row.size < 2 * 1024 * 1024 && row.content_state !== 1) {
      // Not stored (names-only area, say): a small text file can still be read as it is now.
      try {
        const buf = new Uint8Array(readFileSync(row.path))
        if (!looksBinary(buf)) {
          text = decodeText(buf)
          base.source = "disk"
        }
      } catch {
        // unreadable
      }
    }
    if (text === null) return { ...base, message: noTextReason(row) }
    const all = splitLines(text)
    base.totalLines = all.length
    base.pageStarts = pageStartsOf(text)
    const ranges = new Map<number, [number, number][]>()
    if (pattern) {
      const { re, folded } = pattern
      const found: { lines: LineMatch[]; count: number } =
        folded && re.flags.includes("u") && /[^\x00-\x7f]/.test(text)
          ? keywordLines(text, re.source, MAX_MATCH_LINES, false, 10 * MAX_MATCH_LINES)
          : findLines(text, re, MAX_MATCH_LINES, 10 * MAX_MATCH_LINES, Date.now() + MATCH_BUDGET_MS, false)
      for (const l of found.lines) {
        if (ranges.has(l.line)) continue
        base.matchLines.push(l.line)
        ranges.set(l.line, l.ranges)
      }
      base.matchesCapped = found.lines.length >= MAX_MATCH_LINES || found.count >= 10 * MAX_MATCH_LINES
    }
    return opts.matchesOnly ? takeMatches(base, all, ranges, opts) : takeRange(base, all, ranges, opts)
  })()
}

function noTextReason(row: Row): string {
  if (row.content_state === 2) return `could not read contents: ${row.note ?? "error"}`
  if (row.content_state === 3) {
    if (row.note === "too-large") return "file is too large to index its contents"
    if (row.note === "binary") return "binary file"
    if (row.note === "empty") return "empty file"
    return "contents not indexed"
  }
  if (row.content_state === 4) return "contents not indexed yet"
  return "no text for this kind of file"
}

/** Adds lines to a result within the character budget, and records where reading stopped. */
class Taker {
  private used = 0
  constructor(
    private out: ReadResult,
    private all: string[],
    private ranges: Map<number, [number, number][]>,
    private opts: ReadOptions,
  ) {}

  get full(): boolean {
    return this.out.lines.length >= this.opts.lines
  }

  /** Add line `n` from `column`; false if the budget ran out first (`next` then says where to go on). */
  add(n: number, column = 1): boolean {
    if (this.full || this.used >= this.opts.maxChars) {
      this.out.next = { line: n, column }
      return false
    }
    const whole = this.all[n - 1]!
    const from = Math.min(column - 1, whole.length)
    let text = whole.slice(from)
    let cut = false
    if (this.used + text.length > this.opts.maxChars) {
      text = text.slice(0, Math.max(1, this.opts.maxChars - this.used))
      cut = from + text.length < whole.length
    }
    this.used += text.length + 1
    const ranges = (this.ranges.get(n) ?? []).map(([a, b]) => [Math.max(0, a - from), Math.min(text.length, b - from)] as [number, number]).filter(([a, b]) => b > a)
    this.out.lines.push({ n, text, ranges, ...(from > 0 ? { column: from + 1 } : {}), ...(cut ? { cut: true } : {}) })
    if (cut) {
      this.out.next = { line: n, column: from + text.length + 1 }
      return false
    }
    return true
  }
}

function takeRange(out: ReadResult, all: string[], ranges: Map<number, [number, number][]>, opts: ReadOptions): ReadResult {
  const start = opts.line ?? (out.matchLines.length ? Math.max(1, out.matchLines[0]! - Math.floor(opts.lines / 4)) : 1)
  if (start > all.length) return out
  const take = new Taker(out, all, ranges, opts)
  for (let n = start; n <= all.length; n++) if (!take.add(n, n === start ? (opts.column ?? 1) : 1)) return out
  return out
}

function takeMatches(out: ReadResult, all: string[], ranges: Map<number, [number, number][]>, opts: ReadOptions): ReadResult {
  const start = opts.line ?? 1
  const ctx = opts.context ?? 0
  const take = new Taker(out, all, ranges, opts)
  let last = start - 1
  for (const m of out.matchLines) {
    if (m < start) continue
    for (let n = Math.max(last + 1, m - ctx); n <= Math.min(all.length, m + ctx); n++) {
      if (!take.add(n, n === start ? (opts.column ?? 1) : 1)) return out
      last = n
    }
  }
  // Matches past the cap: carry on after the last one found.
  if (out.matchesCapped && last < all.length) out.next = { line: last + 1, column: 1 }
  return out
}

function readFolder(out: ReadResult, includeHidden: boolean, opts: ReadOptions): ReadResult {
  let names: string[]
  try {
    names = readdirSync(out.path, { withFileTypes: true })
      .filter((d) => !d.name.startsWith(".") || includeHidden)
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b))
  } catch (err) {
    return { ...out, message: `cannot list folder: ${(err as Error).message}` }
  }
  out.source = "disk"
  out.totalLines = names.length
  if (!names.length) return { ...out, message: "empty folder" }
  const take = new Taker(out, names, new Map(), opts)
  for (let n = opts.line ?? 1; n <= names.length; n++) if (!take.add(n)) break
  return out
}
