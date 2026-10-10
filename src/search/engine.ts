import type { Database } from "bun:sqlite"
import { readdirSync, readFileSync } from "node:fs"
import type { Config } from "../config.ts"
import { decompressText, getMeta } from "../index/db.ts"
import { looksBinary, decodeText } from "../index/extract/text.ts"
import type { Kind } from "../kinds.ts"
import { escapeRegExp, foldTerm, ftsQuote, smartCaseSensitive } from "../util/text.ts"
import { Catalog } from "./catalog.ts"
import { parseFuzzyTerms } from "./fuzzy.ts"
import { type Filters, hasFilters, type Mode, parseQuery, type ParsedQuery } from "./query.ts"
import { literalRequirement, regexRequirements, type Req } from "./regex-plan.ts"
import { findLines, keywordLines, type LineMatch, splitLines, termsPattern } from "./snippet.ts"
import { reqToFts, Vocab } from "./vocab.ts"

export type Source = "name" | "content"

export interface SearchHit {
  id: number
  path: string
  display: string
  kind: Kind
  isDir: boolean
  size: number
  mtime: number
  score: number
  sources: Source[]
  /** Highlight positions in `display`. */
  namePositions: number[]
  /** Best matching lines (content or regex). */
  lines: LineMatch[]
  matchCount: number
}

export interface SearchResponse {
  query: string
  mode: Mode
  /** How the query was run, in words ("exact text (indexed) · …", "regex …", "fuzzy names …"). */
  strategy: string
  resolved: Mode
  hits: SearchHit[]
  total: number
  elapsedMs: number
  partial: boolean
  notice?: string
  error?: string
}

export interface PreviewLine {
  n: number
  text: string
  ranges: [number, number][]
}

export interface Preview {
  id: number
  path: string
  display: string
  kind: Kind
  isDir: boolean
  size: number
  mtime: number
  /** Lines of text around the focus. */
  lines: PreviewLine[]
  totalLines: number
  focusLine: number
  /** 1-based page/slide/sheet number per line start (only for paged documents). */
  pageStarts: number[]
  matchLines: number[]
  message?: string
  note?: string | null
  source: "index" | "disk" | "none"
}

export interface SearchOptions {
  limit?: number
  /** Polled during long scans; return true to abandon the search. */
  cancelled?: () => boolean
  /** Time budget for regex/exact content scans. */
  budgetMs?: number
}

const FETCH_BATCH = 64
/** How many full-text candidates are ranked by their text (the rest by name, folders and date). */
const RANK_POOL = 128

/**
 * Decoded texts by file id, least recently used first. Searching while typing reads the same
 * candidates keystroke after keystroke; this skips their decompression. Cleared whenever the
 * index changes, so it never serves stale text.
 */
class TextCache {
  private map = new Map<number, string>()
  private chars = 0

  constructor(private maxChars: number) {}

  get(id: number): string | undefined {
    const t = this.map.get(id)
    if (t !== undefined) {
      this.map.delete(id)
      this.map.set(id, t)
    }
    return t
  }

  set(id: number, text: string) {
    if (text.length > this.maxChars / 8) return
    const old = this.map.get(id)
    if (old !== undefined) {
      this.chars -= old.length
      this.map.delete(id)
    }
    this.map.set(id, text)
    this.chars += text.length
    for (const [k, v] of this.map) {
      if (this.chars <= this.maxChars) break
      this.map.delete(k)
      this.chars -= v.length
    }
  }

  clear() {
    this.map.clear()
    this.chars = 0
  }

  get full(): boolean {
    return this.chars >= this.maxChars * 0.9
  }
}

/** A query word or phrase: its FTS5 expression, and the terms that count as it when ranking. */
type TermGroup = { expr: string; terms: string[]; prefix: boolean }

type Ranked = { id: number; positions?: number[]; lines?: LineMatch[]; count?: number; raw?: number }

export class SearchEngine {
  readonly catalog = new Catalog()
  readonly vocab = new Vocab()
  private dataVersion = -1
  private generation = ""
  private frecency = new Map<string, { count: number; last: number }>()

  constructor(
    readonly db: Database,
    public config: Config,
    /** How many decoded characters to keep (UTF-16, so about twice that in bytes). */
    textCacheChars = 24_000_000,
  ) {
    this.texts = new TextCache(textCacheChars)
    this.refresh(true)
  }

  /** Pick up index changes made by another connection (the indexer). Returns true if anything changed. */
  refresh(force = false): boolean {
    const dv = (this.db.query("PRAGMA data_version").get() as { data_version: number }).data_version
    if (!force && dv === this.dataVersion) return false
    this.dataVersion = dv
    this.texts.clear()
    this.warmOrder = null
    const gen = `${getMeta(this.db, "generation") ?? 0}:${getMeta(this.db, "schema_version")}`
    const full = force || gen !== this.generation
    this.generation = gen
    this.catalog.load(this.db, !full)
    this.vocab.load(this.db, !full)
    this.frecency.clear()
    for (const r of this.db.query("SELECT path, count, last FROM frecency").all() as { path: string; count: number; last: number }[]) this.frecency.set(r.path, r)
    for (const o of this.unsaved) this.countOpen(o.path, o.at)
    return true
  }

  /* ------------------------------------------------------------ public -- */

  async search(rawQuery: string, mode: Mode = "find", opts: SearchOptions = {}): Promise<SearchResponse> {
    const t0 = performance.now()
    this.refresh()
    const q = parseQuery(rawQuery)
    this.now = Date.now()
    this.lastExpansions = []
    const limit = q.filters.limit ?? opts.limit ?? 100
    const effective: Mode = q.forcedMode ?? mode
    const res: SearchResponse = { query: rawQuery, mode, resolved: effective, strategy: "", hits: [], total: 0, elapsedMs: 0, partial: false }
    if (q.warnings.length) res.notice = q.warnings.join("; ")
    try {
      if (!q.text && !q.phrases.length) {
        if (hasFilters(q.filters)) {
          res.strategy = "recent files matching filters"
          const idx = this.catalog.browse(q.filters, limit)
          res.hits = idx.map((i) => this.hit(this.catalog.ids[i]!, 0, ["name"]))
          res.total = res.hits.length
        } else {
          res.strategy = "recent"
          res.hits = this.recent(limit)
          res.total = res.hits.length
        }
        return this.done(res, t0)
      }
      if (effective === "fuzzy") await this.runFuzzy(q, limit, res)
      else await this.runGrep(q, limit, res, q.regex, opts)
    } catch (err) {
      res.error = (err as Error).message
    }
    return this.done(res, t0)
  }

  private done(res: SearchResponse, t0: number): SearchResponse {
    res.elapsedMs = performance.now() - t0
    return res
  }

  /* ---------------------------------------------------------- strategy -- */

  private async runFuzzy(q: ParsedQuery, limit: number, res: SearchResponse) {
    const query = fuzzyQueryText(q)
    const names = this.nameMatches(q, limit, 0)
    const lists: { name: string; weight: number; items: Ranked[]; source: Source }[] = [{ name: "names", weight: 1.3, items: names, source: "name" }]
    if (names.length < limit / 4) {
      const typo = this.catalog.typo(query, q.filters, limit).map((m) => ({ id: this.catalog.ids[m.idx]!, positions: m.positions }))
      lists.push({ name: "typo", weight: 0.9, items: typo, source: "name" })
    }
    // fzf operators ('exact ^prefix suffix$ !not) are about names only.
    const operators = parseFuzzyTerms(query).some((t) => t.kind !== "fuzzy" || t.negate)
    if (!operators) lists.push({ name: "text", weight: 0.6, items: this.keywordMatches(q, limit, q.typing, true), source: "content" })
    res.strategy = operators ? "fuzzy names" : "fuzzy names + typo-tolerant text"
    this.fuse(lists, limit, res, q)
    res.total = Math.max(res.total, this.catalog.lastMatchCount)
  }

  /* ------------------------------------------------------------- names -- */

  private nameMatches(q: ParsedQuery, limit: number, minQuality: number): Ranked[] {
    const query = fuzzyQueryText(q)
    if (!query.trim()) return []
    const terms = parseFuzzyTerms(query).filter((t) => !t.negate)
    const ideal = terms.reduce((s, t) => s + 22 * t.text.length + 24, 0)
    const raw = this.catalog.fuzzy(query, q.filters, Math.max(limit * 2, 100), (i) => this.bias(i))
    return raw
      .filter((m) => minQuality === 0 || m.score >= ideal * minQuality)
      .slice(0, limit)
      .map((m) => ({ id: this.catalog.ids[m.idx]!, positions: m.positions, raw: m.score }))
  }

  private now = Date.now()

  /** Points for files opened often and recently through zsearch (0..30). */
  private frecencyPoints(i: number): number {
    if (this.frecency.size === 0) return 0
    const f = this.frecency.get(this.catalog.paths[i]!)
    if (!f) return 0
    const ageDays = (this.now - f.last) / 86_400_000
    return Math.min(30, 8 * Math.log2(1 + f.count)) * Math.exp(-ageDays / 30)
  }

  /** Points for recently modified files (0..4). */
  private recencyPoints(i: number): number {
    const age = (this.now - this.catalog.mtimes[i]!) / 86_400_000
    return age < 7 ? 4 : age < 30 ? 2 : 0
  }

  /** Frecency + recency points added to fuzzy name scores. */
  private bias(i: number): number {
    return this.frecencyPoints(i) + this.recencyPoints(i)
  }

  private recent(limit: number): SearchHit[] {
    // Frecent files first, then recently modified files.
    const hits: SearchHit[] = []
    const seen = new Set<number>()
    const frec = [...this.frecency.entries()].sort((a, b) => b[1].last - a[1].last)
    for (const [path] of frec) {
      const i = this.catalog.paths.indexOf(path)
      if (i < 0) continue
      hits.push(this.hit(this.catalog.ids[i]!, 0, ["name"]))
      seen.add(i)
      if (hits.length >= Math.min(limit, 20)) break
    }
    const idx: number[] = []
    for (let i = 0; i < this.catalog.size; i++) if (!this.catalog.isDir[i] && !seen.has(i)) idx.push(i)
    idx.sort((a, b) => this.catalog.mtimes[b]! - this.catalog.mtimes[a]!)
    for (const i of idx.slice(0, limit - hits.length)) hits.push(this.hit(this.catalog.ids[i]!, 0, ["name"]))
    return hits
  }

  /* ----------------------------------------------------------- keyword -- */

  /** Vocabulary terms the last typo-tolerant query expanded to (for highlighting). */
  lastExpansions: string[] = []

  /**
   * The query words and phrases as FTS5 expressions, each with the terms that count as it when
   * ranking. `typos` expands each word to similar vocabulary terms.
   */
  private keywordGroups(q: ParsedQuery, prefixLast: boolean, typos = false): TermGroup[] {
    const groups: TermGroup[] = []
    if (typos) this.lastExpansions = []
    const words = q.words.filter((w) => /[\p{L}\p{N}]/u.test(w))
    words.forEach((w, i) => {
      const tokens = foldTerm(w).match(/[\p{L}\p{N}]+/gu)
      if (!tokens) return
      const isLast = i === words.length - 1
      const prefix = prefixLast && isLast && tokens[tokens.length - 1]!.length >= 3
      let expr = ftsWords(tokens, prefix)
      const terms = [...tokens]
      if (typos && tokens.length === 1) {
        const t = tokens[0]!
        const alts = new Set<string>([...this.vocab.similar(t)])
        if (t.length >= 4) for (const c of this.vocab.containing(t, 40) ?? []) alts.add(c)
        alts.delete(t)
        const some = [...alts].slice(0, 48)
        this.lastExpansions.push(...some)
        terms.push(...some)
        if (some.length) expr = `(${[expr, ...some.map(ftsQuote)].join(" OR ")})`
      }
      groups.push({ expr, terms, prefix })
    })
    for (const p of q.phrases) {
      const tokens = foldTerm(p).match(/[\p{L}\p{N}]+/gu)
      if (tokens) groups.push({ expr: ftsWords(tokens, false), terms: tokens, prefix: false })
    }
    return groups
  }

  /** One FTS5 expression for the groups: all of them (or `any`), minus the negated words. */
  private groupsExpr(q: ParsedQuery, groups: TermGroup[], any: boolean): string | null {
    if (!groups.length) return null
    let expr = groups.map((g) => g.expr).join(any ? " OR " : " AND ")
    const neg = q.negated.flatMap((n) => foldTerm(n).match(/[\p{L}\p{N}]+/gu) ?? []).map(ftsQuote)
    if (neg.length) expr = `(${expr}) NOT (${neg.join(" OR ")})`
    return expr
  }

  keywordExpr(q: ParsedQuery, prefixLast: boolean, typos = false, any = false): string | null {
    return this.groupsExpr(q, this.keywordGroups(q, prefixLast, typos), any)
  }

  private keywordMatches(q: ParsedQuery, limit: number, prefixLast: boolean, typos = false): Ranked[] {
    const groups = this.keywordGroups(q, prefixLast, typos)
    const ids = (expr: string | null): number[] => {
      if (!expr) return []
      try {
        return (this.db.query("SELECT rowid FROM fts WHERE fts MATCH ?").values(expr) as number[][]).map((r) => r[0]!)
      } catch {
        return []
      }
    }
    let matches = ids(this.groupsExpr(q, groups, false))
    // Several words but no document has all of them: fall back to any of them.
    if (matches.length === 0 && groups.length > 1) matches = ids(this.groupsExpr(q, groups, true))
    return this.rankMatches(matches, groups, q.filters, limit)
  }

  /**
   * Order full-text matches by relevance, BM25 style. The index keeps which columns hold a term
   * but not how often (contentless, detail=column), which leaves FTS5's bm25() with nothing to
   * score, so this scores the file name and folders from the path, and the text itself for the
   * RANK_POOL best candidates by path score, then date.
   */
  private rankMatches(ids: number[], groups: TermGroup[], filters: Filters, limit: number): Ranked[] {
    const cat = this.catalog
    const idx: number[] = []
    for (const id of ids) {
      const i = cat.indexOf(id)
      if (i !== undefined && cat.passes(i, filters)) idx.push(i)
    }
    if (!idx.length || !groups.length) return []
    const res = groups.map((g) => {
      const words = g.terms.map(escapeRegExp).join("|")
      // ASCII terms (the usual case) take the faster \b form; \b is ASCII only.
      if (g.terms.every((t) => /^[a-z0-9]+$/.test(t))) return new RegExp(`\\b(?:${words})${g.prefix ? "\\w*" : "\\b"}`, "gi")
      return new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})${g.prefix ? "[\\p{L}\\p{N}]*" : "(?![\\p{L}\\p{N}])"}`, "giu")
    })
    // Rarer words count for more. With one word every candidate shares the same weight.
    const total = Math.max(cat.size, 1)
    const idf = groups.map((g) => {
      if (groups.length === 1) return 1
      let df = idx.length
      try {
        df = (this.db.query("SELECT count(*) AS n FROM fts WHERE fts MATCH ?").get(g.expr) as { n: number }).n
      } catch {
        // keep the candidate count
      }
      return Math.log(1 + (total - df + 0.5) / (df + 0.5))
    })
    const count = (re: RegExp, text: string, max: number) => {
      re.lastIndex = 0
      let n = 0
      while (n < max && re.exec(text)) n++
      return n
    }
    const K1 = 1.2
    const B = 0.75
    const sat = (tf: number) => (tf * (K1 + 1)) / (tf + K1)
    // Name and folders, weighted 10 and 2.5 against the text, as bm25(fts, 10, 2.5, 1) did.
    // For words in most files, testing every path costs more than it tells: date order instead.
    const score = new Map<number, number>()
    if (idx.length <= 25_000) {
      for (const i of idx) {
        const disp = cat.display[i]!
        const start = cat.nameStart[i]!
        const name = disp.slice(start)
        const dirs = disp.slice(0, start)
        let s = 0
        for (let g = 0; g < groups.length; g++) s += idf[g]! * (10 * sat(count(res[g]!, name, 20)) + 2.5 * sat(count(res[g]!, dirs, 20)))
        if (s > 0) score.set(i, s)
      }
    }
    const byPathThenDate = (a: number, b: number) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || cat.mtimes[b]! - cat.mtimes[a]!
    idx.sort(byPathThenDate)
    const pool = idx.slice(0, Math.max(RANK_POOL, limit))
    const texts = new Map<number, string>()
    for (let start = 0; start < pool.length; start += FETCH_BATCH) {
      for (const [id, t] of this.batchTexts(pool.slice(start, start + FETCH_BATCH).map((i) => cat.ids[i]!))) texts.set(id, t)
    }
    let avg = 0
    for (const t of texts.values()) avg += t.length
    avg = texts.size ? avg / texts.size : 1
    for (const i of pool) {
      const text = texts.get(cat.ids[i]!)
      if (!text) continue
      const norm = K1 * (1 - B + (B * text.length) / Math.max(avg, 1))
      let s = 0
      for (let g = 0; g < groups.length; g++) {
        const tf = count(res[g]!, text, 1000)
        s += (idf[g]! * tf * (K1 + 1)) / (tf + norm)
      }
      score.set(i, (score.get(i) ?? 0) + s)
    }
    pool.sort(byPathThenDate)
    return [...pool, ...idx.slice(pool.length)].slice(0, limit).map((i) => ({ id: cat.ids[i]!, raw: score.get(i) ?? 0 }))
  }

  private fetchStmt: ReturnType<Database["query"]> | null = null
  /** About 48 MB of decoded text (UTF-16) by default. */
  private texts: TextCache

  /** Catalog positions newest first, and how far `warmTexts` got through them. */
  private warmOrder: number[] | null = null
  private warmPos = 0

  /**
   * Decode the newest files' texts into the cache, for at most `budgetMs`. Called while the
   * engine is idle so that the first searches after start-up or an index change are warm.
   * Returns false when there is nothing left to do.
   */
  warmTexts(budgetMs: number): boolean {
    const cat = this.catalog
    if (!this.warmOrder) {
      this.warmOrder = Array.from({ length: cat.size }, (_, i) => i).filter((i) => !cat.isDir[i])
      this.warmOrder.sort((a, b) => cat.mtimes[b]! - cat.mtimes[a]!)
      this.warmPos = 0
    }
    const end = performance.now() + budgetMs
    while (this.warmPos < this.warmOrder.length && !this.texts.full) {
      if (performance.now() > end) return true
      const ids = this.warmOrder.slice(this.warmPos, this.warmPos + FETCH_BATCH).map((i) => cat.ids[i]!)
      this.warmPos += FETCH_BATCH
      for (const row of this.fetchContent(ids)) this.storedText(row.id, row.data)
    }
    return false
  }

  /** A file's stored text, decoded (cached), or null if it has none. */
  private storedText(id: number, data?: Uint8Array): string | null {
    const cached = this.texts.get(id)
    if (cached !== undefined) return cached
    if (!data) {
      const row = this.db.query("SELECT data FROM content WHERE id = ?").get(id) as { data: Uint8Array } | null
      if (!row) return null
      data = row.data
    }
    const text = decompressText(data)
    this.texts.set(id, text)
    return text
  }

  /**
   * Decoded texts of up to FETCH_BATCH files, read in one query. Cached texts are taken first:
   * decoding the others can evict them from the cache.
   */
  private batchTexts(ids: number[]): Map<number, string> {
    const texts = new Map<number, string>()
    const missing: number[] = []
    for (const id of ids) {
      const t = this.texts.get(id)
      if (t !== undefined) texts.set(id, t)
      else missing.push(id)
    }
    if (missing.length) for (const row of this.fetchContent(missing)) texts.set(row.id, this.storedText(row.id, row.data)!)
    return texts
  }

  /** Stored texts for up to FETCH_BATCH ids, in no particular order. */
  private fetchContent(ids: number[]): { id: number; data: Uint8Array }[] {
    this.fetchStmt ??= this.db.query(`SELECT id, data FROM content WHERE id IN (${Array(FETCH_BATCH).fill("?").join(",")})`)
    const args = ids.length === FETCH_BATCH ? ids : [...ids, ...Array(FETCH_BATCH - ids.length).fill(-1)]
    return this.fetchStmt.all(...args) as { id: number; data: Uint8Array }[]
  }

  /* ---------------------------------------------------- regex / exact -- */

  private buildRegex(q: ParsedQuery, isRegex: boolean): { re: RegExp; req: Req; ci: boolean } {
    const text = isRegex ? q.text : q.phrases.length && !q.words.length ? q.phrases.join(" ") : q.text
    const ci = !smartCaseSensitive(text)
    const source = isRegex ? text : escapeRegExp(text)
    let re: RegExp
    try {
      re = new RegExp(source, `gm${ci ? "i" : ""}`)
    } catch {
      try {
        re = new RegExp(source, `gmu${ci ? "i" : ""}`)
      } catch (err) {
        throw new Error(`invalid regex: ${(err as Error).message.replace(/^Invalid regular expression: /, "")}`)
      }
    }
    const req = isRegex ? regexRequirements(source, ci) : literalRequirement(text, ci)
    return { re, req, ci }
  }

  private async runGrep(q: ParsedQuery, limit: number, res: SearchResponse, isRegex: boolean, opts: SearchOptions) {
    const { re, req } = this.buildRegex(q, isRegex)
    const budget = opts.budgetMs ?? 2500
    const deadline = Date.now() + budget
    // Names first: regex over the displayed path.
    const nameRe = new RegExp(re.source, re.flags.replace("g", "").replace("m", ""))
    const nameHits = this.catalog.regex(nameRe, q.filters, limit)
    const contentHits: Ranked[] = []
    const expr = reqToFts(req, this.vocab)
    let scanned = 0
    let candidates = 0
    const check = (id: number, text: string): boolean => {
      scanned++
      const { lines, count } = findLines(text, re, 20, 10_000, deadline)
      if (count > 0) contentHits.push({ id, lines, count })
      return contentHits.length >= limit
    }
    if (expr !== "__no_match__") {
      // Candidate ids from FTS alone (no join), then filtered and ordered newest first with the
      // in-memory catalog: several times faster than letting SQLite join and sort.
      let ids: number[]
      try {
        ids = expr ? (this.db.query("SELECT rowid FROM fts WHERE fts MATCH ?").values(`body : (${expr})`) as number[][]).map((r) => r[0]!) : this.catalog.ids
      } catch (err) {
        throw new Error(`search failed: ${(err as Error).message}`)
      }
      const cat = this.catalog
      const idx: number[] = []
      for (const id of ids) {
        const i = cat.indexOf(id)
        // No content-state check: the catalog does not follow content-state changes during an
        // index run, and a file without stored text simply has no row in the batch fetch below.
        if (i !== undefined && !cat.isDir[i] && cat.passes(i, q.filters)) idx.push(i)
      }
      idx.sort((a, b) => cat.mtimes[b]! - cat.mtimes[a]!)
      candidates = idx.length
      let lastYield = Date.now()
      // Texts are read in batches: one query per 64 files instead of one per file.
      scan: for (let start = 0; start < idx.length; start += FETCH_BATCH) {
        const batch = idx.slice(start, start + FETCH_BATCH).map((i) => cat.ids[i]!)
        const texts = this.batchTexts(batch)
        for (const id of batch) {
          const text = texts.get(id)
          if (text !== undefined && check(id, text)) break scan
        }
        const now = Date.now()
        if (now > deadline) {
          res.partial = true
          break
        }
        if (now - lastYield > 40) {
          // Let newer requests in; abandon this scan if one superseded it.
          await new Promise((r) => setImmediate(r))
          lastYield = Date.now()
          if (opts.cancelled?.()) {
            res.partial = true
            break
          }
        }
      }
    }
    res.strategy = `${isRegex ? "regex" : "exact text"} ${expr ? "(indexed)" : "(full scan)"} · ${scanned.toLocaleString("en-US")} of ${candidates.toLocaleString("en-US")} files read`
    contentHits.sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    const lists: { name: string; weight: number; items: Ranked[]; source: Source }[] = [
      { name: "names", weight: 1, items: nameHits.map((m) => ({ id: this.catalog.ids[m.idx]!, positions: m.positions })), source: "name" },
      { name: "content", weight: 1, items: contentHits, source: "content" },
    ]
    this.fuse(lists, limit, res, q, true)
    // A file can match by name and by content: count it once.
    const ids = new Set([...nameHits.map((m) => this.catalog.ids[m.idx]!), ...contentHits.map((h) => h.id)])
    res.total = Math.max(res.total, ids.size)
  }

  /* ------------------------------------------------------------ fusion -- */

  private hit(id: number, score: number, sources: Source[]): SearchHit {
    const i = this.catalog.indexOf(id)
    if (i === undefined) {
      const r = this.db.query("SELECT path, kind, is_dir, size, mtime FROM files WHERE id = ?").get(id) as { path: string; kind: Kind; is_dir: number; size: number; mtime: number } | null
      return {
        id,
        path: r?.path ?? "",
        display: r ? this.catalog.displayFor(r.path) : "",
        kind: r?.kind ?? "other",
        isDir: r?.is_dir === 1,
        size: r?.size ?? 0,
        mtime: r?.mtime ?? 0,
        score,
        sources,
        namePositions: [],
        lines: [],
        matchCount: 0,
      }
    }
    const c = this.catalog
    return {
      id,
      path: c.paths[i]!,
      display: c.display[i]!,
      kind: c.kinds[i]!,
      isDir: c.isDir[i] === 1,
      size: c.sizes[i]!,
      mtime: c.mtimes[i]!,
      score,
      sources,
      namePositions: [],
      lines: [],
      matchCount: 0,
    }
  }

  /** Reciprocal-rank fusion of several ranked lists, then snippets for the winners. */
  private fuse(lists: { name: string; weight: number; items: Ranked[]; source: Source }[], limit: number, res: SearchResponse, q: ParsedQuery, keepLines = false) {
    const K = 20
    const acc = new Map<number, { score: number; sources: Set<Source>; positions?: number[]; lines?: LineMatch[]; count: number }>()
    for (const list of lists) {
      list.items.forEach((item, rank) => {
        let e = acc.get(item.id)
        if (!e) acc.set(item.id, (e = { score: 0, sources: new Set(), count: 0 }))
        e.score += list.weight / (K + rank + 1)
        e.sources.add(list.source)
        if (item.positions && !e.positions) e.positions = item.positions
        if (item.lines && (!e.lines || list.source === "content")) e.lines = item.lines
        if (item.count) e.count = Math.max(e.count, item.count)
      })
    }
    const ranked = [...acc.entries()]
      .map(([id, e]) => {
        const i = this.catalog.indexOf(id)
        // Frequently/recently opened files get up to +15%, recently modified ones +1%.
        // (Name matching already counts frecency in full; here it only breaks near-ties.)
        const boost = i === undefined ? 0 : this.frecencyPoints(i) / 200 + this.recencyPoints(i) / 400
        return { id, e, score: e.score * (1 + boost) }
      })
      .sort((a, b) => b.score - a.score)
    res.total = Math.max(res.total, ranked.length)
    const top = ranked.slice(0, limit)
    // Typo expansions are highlighted as whole words.
    const pattern = keepLines ? null : termsPattern(q.words, [...q.phrases, ...this.lastExpansions], q.typing)
    res.hits = top.map(({ id, e, score }, n) => {
      const h = this.hit(id, score, [...e.sources])
      if (e.positions) h.namePositions = e.positions
      h.matchCount = e.count
      if (e.lines) h.lines = e.lines
      else if (pattern && e.sources.has("content") && n < 60) {
        const s = this.snippets(id, pattern)
        h.lines = s.lines
        h.matchCount = s.count
      }
      return h
    })
  }

  /** Matching lines for a keyword query. */
  snippets(id: number, pattern: string, maxLines = 8): { lines: LineMatch[]; count: number } {
    const text = this.storedText(id)
    if (text === null) return { lines: [], count: 0 }
    try {
      return keywordLines(text, pattern, maxLines)
    } catch {
      return { lines: [], count: 0 }
    }
  }

  /* ----------------------------------------------------------- preview -- */

  preview(id: number, rawQuery: string, mode: Mode, focusLineHint?: number, window = 400): Preview {
    // The text cache must not outlive an index update made by another process.
    this.refresh()
    const i = this.catalog.indexOf(id)
    const row = this.db.query("SELECT path, kind, is_dir, size, mtime, content_state, note FROM files WHERE id = ?").get(id) as {
      path: string
      kind: Kind
      is_dir: number
      size: number
      mtime: number
      content_state: number
      note: string | null
    } | null
    const base: Preview = {
      id,
      path: row?.path ?? (i !== undefined ? this.catalog.paths[i]! : ""),
      display: row ? this.catalog.displayFor(row.path) : "",
      kind: row?.kind ?? "other",
      isDir: row?.is_dir === 1,
      size: row?.size ?? 0,
      mtime: row?.mtime ?? 0,
      lines: [],
      totalLines: 0,
      focusLine: 1,
      pageStarts: [],
      matchLines: [],
      note: row?.note ?? null,
      source: "none",
    }
    if (!row) return { ...base, message: "file is no longer in the index" }
    if (row.is_dir) return this.folderPreview(base)
    let text: string | null = null
    const stored = this.storedText(id)
    if (stored !== null) {
      text = stored
      base.source = "index"
    } else if (row.size > 0 && row.size < 2 * 1024 * 1024 && row.content_state !== 1) {
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
    if (text === null) {
      const why =
        row.content_state === 2
          ? `could not read contents: ${row.note ?? "error"}`
          : row.content_state === 3
            ? row.note === "too-large"
              ? "file is too large to index its contents"
              : row.note === "binary"
                ? "binary file"
                : row.note === "empty"
                  ? "empty file"
                  : "contents not indexed"
            : row.content_state === 4
              ? "contents not indexed yet"
              : "no text preview for this kind of file"
      return { ...base, message: why }
    }
    const all = splitLines(text)
    base.totalLines = all.length
    // Page starts for paged documents (PDF pages, slides, sheets).
    if (text.includes("\f")) {
      let page = 1
      let lineNo = 1
      base.pageStarts.push(1)
      for (let k = 0; k < text.length; k++) {
        const c = text.charCodeAt(k)
        if (c === 10) lineNo++
        else if (c === 12) {
          lineNo++
          page++
          base.pageStarts.push(lineNo)
        }
      }
    }
    // Matches for highlighting.
    let pattern: ReturnType<SearchEngine["matchPattern"]> = null
    try {
      pattern = this.matchPattern(rawQuery, mode)
    } catch {
      pattern = null
    }
    const matchRanges = new Map<number, [number, number][]>()
    if (pattern) {
      const re = pattern.re
      const r = /[^\x00-\x7f]/.test(text) && re.flags.includes("u") && pattern.folded ? keywordLines(text, re.source, 2000) : findLines(text, re, 2000, 20_000, Date.now() + 500, false)
      for (const l of r.lines) {
        base.matchLines.push(l.line)
        if (!matchRanges.has(l.line)) matchRanges.set(l.line, l.ranges)
      }
    }
    const focus = focusLineHint ?? base.matchLines[0] ?? 1
    base.focusLine = focus
    const from = Math.max(1, focus - Math.floor(window / 4))
    const to = Math.min(all.length, from + window - 1)
    for (let n = from; n <= to; n++) {
      const t = all[n - 1]!
      base.lines.push({ n, text: t.length > 2000 ? t.slice(0, 2000) + "…" : t, ranges: (matchRanges.get(n) ?? []).filter(([a]) => a < 2000) })
    }
    return base
  }

  /**
   * The regex (with the `g` flag) that marks a query's matches in a file's text, or null when
   * the query has no text to match. `folded`: match on folded text (fuzzy mode), as snippets do.
   * Throws on an invalid regex.
   */
  matchPattern(rawQuery: string, mode: Mode): { re: RegExp; folded: boolean } | null {
    const q = parseQuery(rawQuery)
    if ((q.forcedMode ?? mode) === "find") return q.text ? { re: this.buildRegex(q, q.regex).re, folded: false } : null
    const p = termsPattern(q.words, q.phrases, q.typing)
    return p ? { re: new RegExp(p, "giu"), folded: true } : null
  }

  private folderPreview(base: Preview): Preview {
    let names: string[] = []
    try {
      names = readdirSync(base.path, { withFileTypes: true })
        .filter((d) => !d.name.startsWith(".") || this.config.includeHidden)
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
        .sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b))
    } catch (err) {
      return { ...base, message: `cannot list folder: ${(err as Error).message}` }
    }
    return {
      ...base,
      source: "disk",
      totalLines: names.length,
      lines: names.slice(0, 500).map((n, k) => ({ n: k + 1, text: n, ranges: [] })),
      message: names.length ? undefined : "empty folder",
    }
  }

  /* --------------------------------------------------------- frecency -- */

  recordOpen(path: string) {
    const now = Date.now()
    this.countOpen(path, now)
    this.unsaved.push({ path, at: now })
    this.saveOpens()
  }

  private countOpen(path: string, at: number) {
    const f = this.frecency.get(path)
    this.frecency.set(path, { count: (f?.count ?? 0) + 1, last: Math.max(at, f?.last ?? 0) })
  }

  /** Opens counted but not stored yet (see `saveOpens`). */
  private unsaved: { path: string; at: number }[] = []
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Store the opens counted so far. While an index run writes contents, the database can stay
   * locked for a second or more: rather than hold up searches that long, the opens wait here
   * and are tried again shortly.
   */
  private saveOpens() {
    if (this.saveTimer || !this.unsaved.length) return
    const opens = this.unsaved
    const timeout = (this.db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout
    try {
      this.db.exec(`PRAGMA busy_timeout = ${OPEN_WAIT_MS}`)
      const put = this.db.query("INSERT INTO frecency(path, count, last) VALUES (?, 1, ?) ON CONFLICT(path) DO UPDATE SET count = count + 1, last = excluded.last")
      this.db.transaction(() => {
        for (const o of opens) put.run(o.path, o.at)
      })()
      this.unsaved = []
    } catch (err) {
      if (!String((err as { code?: string }).code).startsWith("SQLITE_BUSY")) {
        this.unsaved = []
        throw err
      }
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null
        this.saveOpens()
      }, OPEN_RETRY_MS)
      this.saveTimer.unref?.()
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${timeout}`)
    }
  }
}

/** How long recording an open waits for the database, and when it tries again if that was not enough. */
const OPEN_WAIT_MS = 20
const OPEN_RETRY_MS = 250

/** The query text for name matching, with negations as fzf `!` terms. */
function fuzzyQueryText(q: ParsedQuery): string {
  const parts = [...q.words, ...q.phrases.map((p) => `'${p.replace(/\s+/g, " ")}`)]
  for (const n of q.negated) parts.push(`!${n}`)
  return parts.join(" ")
}

/** All of `tokens` (the index keeps no word positions, so a phrase is matched as its words), the last one optionally as a prefix. */
function ftsWords(tokens: string[], prefixLast: boolean): string {
  const quoted = tokens.map((t, i) => (prefixLast && i === tokens.length - 1 ? `${ftsQuote(t)}*` : ftsQuote(t)))
  return quoted.length === 1 ? quoted[0]! : `(${quoted.join(" AND ")})`
}
