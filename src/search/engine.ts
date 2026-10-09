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
  /** What auto mode decided, in words ("names + text", "regex", ...). */
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

type Ranked = { id: number; positions?: number[]; lines?: LineMatch[]; count?: number; raw?: number }

const QUESTION = /^(how|what|why|where|when|who|which|whose|whom|is|are|does|do|can|could|should|would|find|show|list|documents?|files?|notes?|anything|something|papers?)\b/i
const QUESTION_WORDS = new Set("how what why where when who which whose whom find show list did does do can could should would write wrote written".split(" "))
const STOP = new Set("a an the of to in on for and or with about from by at as is are was were be this that these those my your our their it its me i".split(" "))

/** Does the text look like a regular expression rather than words? */
export function looksLikeRegex(text: string): boolean {
  if (!text) return false
  const signals = /\\[dwsbDWSB]|\.\*|\.\+|\.\?|\[\^|\[[^\]\s]-[^\]\s]\]|\(\?[:=!<]|\{\d+(,\d*)?\}|^\^\S|\S\$$|\w\|\w|\(\w+\|\w+\)|\\\.|\\\(/
  if (!signals.test(text)) return false
  try {
    new RegExp(text)
    return true
  } catch {
    return false
  }
}

export function isNaturalLanguage(q: ParsedQuery): boolean {
  const words = q.words.filter((w) => /^[\p{L}\p{N}'’-]+$/u.test(w))
  if (q.text.trim().endsWith("?")) return true
  if (words.length !== q.words.length) return false
  const content = words.filter((w) => !STOP.has(w.toLowerCase()))
  if (QUESTION.test(q.text) && words.length >= 3) return true
  return words.length >= 4 && content.length >= 2
}

export class SearchEngine {
  readonly catalog = new Catalog()
  readonly vocab = new Vocab()
  private dataVersion = -1
  private generation = ""
  private frecency = new Map<string, { count: number; last: number }>()

  constructor(
    readonly db: Database,
    public config: Config,
  ) {
    this.refresh(true)
  }

  /** Pick up index changes made by another connection (the indexer). Returns true if anything changed. */
  refresh(force = false): boolean {
    const dv = (this.db.query("PRAGMA data_version").get() as { data_version: number }).data_version
    if (!force && dv === this.dataVersion) return false
    this.dataVersion = dv
    const gen = `${getMeta(this.db, "generation") ?? 0}:${getMeta(this.db, "schema_version")}`
    const full = force || gen !== this.generation
    this.generation = gen
    this.catalog.load(this.db, !full)
    this.vocab.load(this.db, !full)
    this.frecency.clear()
    for (const r of this.db.query("SELECT path, count, last FROM frecency").all() as { path: string; count: number; last: number }[]) this.frecency.set(r.path, r)
    return true
  }

  /* ------------------------------------------------------------ public -- */

  async search(rawQuery: string, mode: Mode = "auto", opts: SearchOptions = {}): Promise<SearchResponse> {
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
      switch (effective) {
        case "fuzzy":
          await this.runFuzzy(q, limit, res)
          break
        case "exact":
          await this.runGrep(q, limit, res, false, opts)
          break
        case "regex":
          await this.runGrep(q, limit, res, true, opts)
          break
        default:
          await this.runAuto(q, limit, res, opts)
      }
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

  private async runAuto(q: ParsedQuery, limit: number, res: SearchResponse, opts: SearchOptions) {
    const text = q.text
    if (looksLikeRegex(text)) {
      res.resolved = "regex"
      return this.runGrep(q, limit, res, true, opts, "auto → regex")
    }
    if (q.phrases.length === 1 && !q.words.length && text.startsWith('"')) {
      res.resolved = "exact"
      return this.runGrep({ ...q, text: q.phrases[0]! }, limit, res, false, opts, "auto → exact phrase")
    }
    const natural = isNaturalLanguage(q)
    const lists: { name: string; weight: number; items: Ranked[]; source: Source }[] = []
    const names = this.nameMatches(q, limit, 0.55)
    const keyword = this.keywordMatches(q, Math.max(limit, 50), q.typing, false, natural)
    // Documents matching only some of the words are weaker evidence.
    const keywordWeight = this.lastKeywordWasOr ? 0.5 : 1
    lists.push({ name: "names", weight: natural ? 0.6 : 1.25, items: names, source: "name" })
    lists.push({ name: "text", weight: keywordWeight, items: keyword, source: "content" })
    const parts = ["names", "text"]
    res.resolved = "auto"
    // Nothing at all? Forgive typos.
    if (lists.every((l) => l.items.length === 0)) {
      const typoNames = this.catalog.typo(q.words.join(" "), q.filters, limit).map((m) => ({ id: this.catalog.ids[m.idx]!, positions: m.positions }))
      const typoText = this.keywordMatches(q, limit, false, true)
      lists.push({ name: "typo-names", weight: 1, items: typoNames, source: "name" })
      lists.push({ name: "typo-text", weight: 0.8, items: typoText, source: "content" })
      parts.splice(0, parts.length, "typo-tolerant names", "text")
    }
    res.strategy = `auto → ${parts.join(" + ")}`
    this.fuse(lists, limit, res, q)
  }

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

  private filterSql(f: Filters): { sql: string; params: (string | number)[] } {
    const where: string[] = []
    const params: (string | number)[] = []
    if (f.kinds) {
      where.push(`f.kind IN (${[...f.kinds].map(() => "?").join(",")})`)
      params.push(...f.kinds)
    }
    if (f.notKinds) {
      where.push(`f.kind NOT IN (${[...f.notKinds].map(() => "?").join(",")})`)
      params.push(...f.notKinds)
    }
    if (f.exts) {
      where.push(`f.ext IN (${[...f.exts].map(() => "?").join(",")})`)
      params.push(...f.exts)
    }
    if (f.inPaths.length) {
      where.push(`(${f.inPaths.map(() => "substr(f.path, 1, ?) = ?").join(" OR ")})`)
      for (const p of f.inPaths) {
        const pre = p === "/" ? "/" : p + "/"
        params.push(pre.length, pre)
      }
    }
    for (const p of f.pathContains) {
      where.push("instr(lower(f.path), ?) > 0")
      params.push(p)
    }
    if (f.sizeMin !== undefined) {
      where.push("f.size >= ?")
      params.push(f.sizeMin)
    }
    if (f.sizeMax !== undefined) {
      where.push("f.size <= ?")
      params.push(f.sizeMax)
    }
    if (f.mtimeMin !== undefined) {
      where.push("f.mtime >= ?")
      params.push(f.mtimeMin)
    }
    if (f.mtimeMax !== undefined) {
      where.push("f.mtime < ?")
      params.push(f.mtimeMax)
    }
    return { sql: where.length ? ` AND ${where.join(" AND ")}` : "", params }
  }

  /** FTS5 expression for the query words. `typos` expands each word to similar vocabulary terms. */
  /** Vocabulary terms the last typo-tolerant query expanded to (for highlighting). */
  lastExpansions: string[] = []

  keywordExpr(q: ParsedQuery, prefixLast: boolean, typos = false, any = false, dropStopwords = false): string | null {
    const parts: string[] = []
    if (typos) this.lastExpansions = []
    let words = q.words.filter((w) => /[\p{L}\p{N}]/u.test(w))
    if (dropStopwords) {
      const content = words.filter((w) => !STOP.has(w.toLowerCase()) && !QUESTION_WORDS.has(w.toLowerCase()))
      if (content.length) words = content
    }
    words.forEach((w, i) => {
      const tokens = foldTerm(w).match(/[\p{L}\p{N}]+/gu)
      if (!tokens) return
      const isLast = i === words.length - 1
      const phrase = ftsQuote(tokens.join(" "))
      const prefix = prefixLast && isLast && tokens[tokens.length - 1]!.length >= 3
      let expr = prefix ? `${phrase}*` : phrase
      if (typos && tokens.length === 1) {
        const t = tokens[0]!
        const alts = new Set<string>([...this.vocab.similar(t)])
        if (t.length >= 4) for (const c of this.vocab.containing(t, 40) ?? []) alts.add(c)
        alts.delete(t)
        this.lastExpansions.push(...[...alts].slice(0, 48))
        if (alts.size) expr = `(${[expr, ...[...alts].slice(0, 48).map(ftsQuote)].join(" OR ")})`
      }
      parts.push(expr)
    })
    for (const p of q.phrases) {
      const tokens = foldTerm(p).match(/[\p{L}\p{N}]+/gu)
      if (tokens) parts.push(ftsQuote(tokens.join(" ")))
    }
    if (!parts.length) return null
    let expr = parts.join(any ? " OR " : " AND ")
    const neg = q.negated.flatMap((n) => foldTerm(n).match(/[\p{L}\p{N}]+/gu) ?? []).map(ftsQuote)
    if (neg.length) expr = `(${expr}) NOT (${neg.join(" OR ")})`
    return expr
  }

  /** Set when the last keyword search had to fall back to matching any word. */
  private lastKeywordWasOr = false

  private keywordMatches(q: ParsedQuery, limit: number, prefixLast: boolean, typos = false, natural = false): Ranked[] {
    this.lastKeywordWasOr = false
    let expr = this.keywordExpr(q, prefixLast, typos, false, natural)
    if (!expr) return []
    const { sql, params } = this.filterSql(q.filters)
    const run = (e: string) => {
      try {
        // bm25 has to score every matching document; for words that occur almost
        // everywhere that costs more than it tells, so rank those by recency instead.
        const count = (this.db.query("SELECT count(*) AS n FROM fts WHERE fts MATCH ?").get(e) as { n: number }).n
        if (count === 0) return []
        if (count > 25_000) {
          return this.db
            .query(`SELECT f.id AS id, 0 AS rank FROM fts JOIN files f ON f.id = fts.rowid WHERE fts MATCH ?${sql} ORDER BY f.mtime DESC LIMIT ?`)
            .all(e, ...params, limit) as { id: number; rank: number }[]
        }
        if (!sql) return this.db.query("SELECT rowid AS id, bm25(fts, 10.0, 2.5, 1.0) AS rank FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?").all(e, limit) as { id: number; rank: number }[]
        return this.db
          .query(`SELECT fts.rowid AS id, bm25(fts, 10.0, 2.5, 1.0) AS rank FROM fts JOIN files f ON f.id = fts.rowid WHERE fts MATCH ?${sql} ORDER BY rank LIMIT ?`)
          .all(e, ...params, limit) as { id: number; rank: number }[]
      } catch {
        return []
      }
    }
    let rows = run(expr)
    // Several words but no document has all of them: fall back to any of them.
    if (rows.length === 0 && q.words.length > 1) {
      expr = this.keywordExpr(q, prefixLast, typos, true, natural)
      if (expr) rows = run(expr)
      this.lastKeywordWasOr = rows.length > 0
    }
    return rows.map((r) => ({ id: r.id, raw: -r.rank }))
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

  private async runGrep(q: ParsedQuery, limit: number, res: SearchResponse, isRegex: boolean, opts: SearchOptions, label?: string) {
    const { re, req } = this.buildRegex(q, isRegex)
    const budget = opts.budgetMs ?? 2500
    const deadline = Date.now() + budget
    // Names first: regex over the displayed path.
    const nameRe = new RegExp(re.source, re.flags.replace("g", "").replace("m", ""))
    const nameHits = this.catalog.regex(nameRe, q.filters, limit)
    const contentHits: Ranked[] = []
    const expr = reqToFts(req, this.vocab)
    const { sql, params } = this.filterSql(q.filters)
    let scanned = 0
    let candidates = 0
    const check = (id: number, data: Uint8Array): boolean => {
      scanned++
      const text = decompressText(data)
      const { lines, count } = findLines(text, re, 20, 10_000, deadline)
      if (count > 0) contentHits.push({ id, lines, count })
      return contentHits.length >= limit
    }
    if (expr !== "__no_match__") {
      // Candidate ids first (cheap to sort), then each file's text by id.
      const idSql = expr
        ? `SELECT f.id FROM fts JOIN files f ON f.id = fts.rowid WHERE fts MATCH ? AND f.content_state = 1${sql} ORDER BY f.mtime DESC`
        : `SELECT f.id FROM files f WHERE f.content_state = 1${sql} ORDER BY f.mtime DESC`
      const args = expr ? [`body : (${expr})`, ...params] : params
      let ids: number[] = []
      try {
        ids = (this.db.query(idSql).values(...args) as number[][]).map((r) => r[0]!)
      } catch (err) {
        throw new Error(`search failed: ${(err as Error).message}`)
      }
      candidates = ids.length
      const getData = this.db.query("SELECT data FROM content WHERE id = ?")
      let lastYield = Date.now()
      for (let n = 0; n < ids.length; n++) {
        const row = getData.get(ids[n]!) as { data: Uint8Array } | null
        if (row && check(ids[n]!, row.data)) break
        if ((n & 15) === 15) {
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
    }
    res.strategy = `${label ?? (isRegex ? "regex" : "exact")} ${expr ? "(indexed)" : "(full scan)"} · ${scanned.toLocaleString("en-US")} of ${candidates.toLocaleString("en-US")} files read`
    contentHits.sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    const lists: { name: string; weight: number; items: Ranked[]; source: Source }[] = [
      { name: "names", weight: 1, items: nameHits.map((m) => ({ id: this.catalog.ids[m.idx]!, positions: m.positions })), source: "name" },
      { name: "content", weight: 1, items: contentHits, source: "content" },
    ]
    this.fuse(lists, limit, res, q, true)
    res.total = Math.max(res.total, nameHits.length + contentHits.length)
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
    const row = this.db.query("SELECT data FROM content WHERE id = ?").get(id) as { data: Uint8Array } | null
    if (!row) return { lines: [], count: 0 }
    try {
      return keywordLines(decompressText(row.data), pattern, maxLines)
    } catch {
      return { lines: [], count: 0 }
    }
  }

  /* ----------------------------------------------------------- preview -- */

  preview(id: number, rawQuery: string, mode: Mode, focusLineHint?: number, window = 400): Preview {
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
    const content = this.db.query("SELECT data FROM content WHERE id = ?").get(id) as { data: Uint8Array } | null
    if (content) {
      text = decompressText(content.data)
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
    const q = parseQuery(rawQuery)
    let re: RegExp | null = null
    const effective = q.forcedMode ?? mode
    try {
      if ((effective === "regex" || (effective === "auto" && looksLikeRegex(q.text))) && q.text) re = this.buildRegex(q, true).re
      else if (effective === "exact" && q.text) re = this.buildRegex(q, false).re
      else {
        const p = termsPattern(q.words, q.phrases, q.typing)
        if (p) re = new RegExp(p, "giu")
      }
    } catch {
      re = null
    }
    const matchRanges = new Map<number, [number, number][]>()
    if (re) {
      const r = /[^\x00-\x7f]/.test(text) && re.flags.includes("u") && !(effective === "regex" || effective === "exact") ? keywordLines(text, re.source, 2000) : findLines(text, re, 2000, 20_000, Date.now() + 500, false)
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
    this.db.query("INSERT INTO frecency(path, count, last) VALUES (?, 1, ?) ON CONFLICT(path) DO UPDATE SET count = count + 1, last = excluded.last").run(path, now)
    const f = this.frecency.get(path)
    this.frecency.set(path, { count: (f?.count ?? 0) + 1, last: now })
  }
}

/** The query text for name matching, with negations as fzf `!` terms. */
function fuzzyQueryText(q: ParsedQuery): string {
  const parts = [...q.words, ...q.phrases.map((p) => `'${p.replace(/\s+/g, " ")}`)]
  for (const n of q.negated) parts.push(`!${n}`)
  return parts.join(" ")
}
