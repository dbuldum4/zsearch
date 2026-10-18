import { boundedFile } from "../util/files.ts"
import type { Database } from "bun:sqlite"
import { type Stats, statSync } from "node:fs"
import type { Config } from "../config.ts"
import { decompressText, getMeta } from "../index/db.ts"
import { looksBinary, decodeText } from "../index/extract/text.ts"
import { crawlOptionsFor, pathPolicy, policyFor } from "../index/policy.ts"
import { onlyKeys, redactPrivateKeys, SECRET_NOTE } from "../index/secrets.ts"
import { type Kind, semanticExcluded } from "../kinds.ts"
import { escapeRegExp, foldTerm, ftsPrefixExpr, ftsTerm, smartCaseSensitive } from "../util/text.ts"
import { Catalog } from "./catalog.ts"
import { parseFuzzyTerms } from "./fuzzy.ts"
import { type Filters, hasFilters, type Mode, parseQuery, type ParsedQuery } from "./query.ts"
import { literalRequirement, regexRequirements, type Req } from "./regex-plan.ts"
import { clipLine, diacriticPattern, findLines, type Folded, foldText, keywordLines, type LineMatch, splitLines, termsPattern } from "./snippet.ts"
import { reqToFts, Vocab } from "./vocab.ts"
import { fileDigest } from "./duplicates.ts"
import { booleanQuery, type QueryExpression } from "./boolean.ts"
import { listFolder, noTextReason, pageStartsOf } from "./read.ts"
import { TopK } from "../util/top-k.ts"
import { retryClock, type RetryClock } from "../util/clock.ts"
import { availableParallelism } from "node:os"
import { Embedder, embedToolPath } from "../semantic/helper.ts"
import { GRANITE, installedModel } from "../semantic/model.ts"
import { bestByFile, CODE_WORD_WEIGHT, coverageGate, RANKING, type Ranking, isLookup, kindHints, meaning, QueryEmbedder, queryTerms, rank, SemanticVectors, VectorIndex, WORD_WEIGHT, wordShares, Z_GATE } from "../semantic/search.ts"
import { semanticDbPath } from "../semantic/store.ts"
import { helperVectorVersion, mainGeneration, semanticFingerprint } from "../semantic/indexer.ts"

type Source = "name" | "content"

/** How long a helper whose version could not be read is left before it is asked again. */
const HELPER_RETRY_MS = 60_000

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
  /** Byte-identical files folded into this one (with `groupDuplicates`), in rank order. */
  copies?: FileCopy[]
}

export interface FileCopy {
  id: number
  path: string
  display: string
  mtime: number
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
  contentAllowed?: boolean
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

interface SearchOptions {
  limit?: number
  /** Polled during long scans; return true to abandon the search. */
  cancelled?: () => boolean
  /** Time budget for regex/exact content scans. */
  budgetMs?: number
  /** Only these files (a part of a grouped query, narrowed by another part). */
  onlyIds?: Set<number>
  /** A part of a grouped query: `limit` alone bounds it, as the query's `limit:` is for the combined results. */
  branch?: boolean
  /** Fold byte-identical files into one hit that lists the others as `copies`. */
  groupDuplicates?: boolean
  /** Hits beyond the limit, for copies to fold into without shortening the page. */
  extra?: number
}

/** One part of a grouped query: its hits, and whether they are all of its matches. */
interface GroupPart {
  hits: Map<number, SearchHit>
  complete: boolean
  total: number
  notices: string[]
  error?: string
}

const FETCH_BATCH = 64
/** How many full-text candidates are ranked by their text (the rest by name, folders and date). */
const RANK_POOL = 128
/** Results each part of a grouped query (`(a OR b) type:pdf`) brings, at most. */
const BRANCH_LIMIT = 5000
/** Hits beyond this many get no snippet lines (fuzzy and semantic): lines cost a text read each. */
const SNIPPET_HITS = 60
/**
 * Grouping copies: hits fetched beyond the limit, the largest file read to compare, the
 * time reading may take per search, and how many file hashes are kept for the next keystrokes.
 */
const COPY_EXTRA = 20
const COPY_MAX_BYTES = 64 * 1024 * 1024
const COPY_BUDGET_MS = 40
const COPY_DIGESTS = 20_000

/**
 * Decoded texts by file id, least recently used first. Searching while typing reads the same
 * candidates keystroke after keystroke; this skips their decompression. Changed and deleted files are evicted after each commit.
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
    this.forms.clear()
    this.formChars = 0
  }

  delete(id: number) {
    const old = this.map.get(id)
    if (old !== undefined) { this.chars -= old.length; this.map.delete(id) }
    const form = this.forms.get(id)
    if (form !== undefined) { this.formChars -= form.text.length; this.forms.delete(id) }
  }

  /**
   * Folded forms of texts (see `foldText`), least recently used first: a text's snippets are
   * found again in its folded form, without folding it again, and its words are counted once.
   * One byte a character.
   */
  private forms = new Map<number, Folded>()
  private formChars = 0

  folded(id: number, text: string): Folded {
    const cached = this.forms.get(id)
    if (cached !== undefined && cached.text.length === text.length) {
      this.forms.delete(id)
      this.forms.set(id, cached)
      return cached
    }
    const form = foldText(text)
    if (text.length > this.maxChars / 8) return form
    if (cached !== undefined) { this.formChars -= cached.text.length; this.forms.delete(id) }
    this.forms.set(id, form)
    this.formChars += text.length
    for (const [k, v] of this.forms) {
      if (this.formChars <= this.maxChars) break
      this.forms.delete(k)
      this.formChars -= v.text.length
    }
    return form
  }

  get full(): boolean {
    return this.chars >= this.maxChars * 0.9
  }
}

/**
 * A query word or phrase: its FTS5 expression, and the terms that count as it when ranking.
 * `check`: the expression also matches files without the word (see `ftsPrefixExpr`), which must
 * have a match for this in their path or text.
 */
type TermGroup = { expr: string; terms: string[]; prefix: boolean; check?: RegExp }

type Ranked = { id: number; positions?: number[]; lines?: LineMatch[]; count?: number; raw?: number }

export class SearchEngine {
  readonly catalog = new Catalog()
  readonly vocab = new Vocab()
  private dataVersion = -1
  private generation = ""
  private cacheSeq = 0
  private cacheRemoved = 0
  private frecencySeq = ""
  private revision = 0
  private frecency = new Map<string, { count: number; last: number }>()

  constructor(
    readonly db: Database,
    public config: Config,
    /** How many decoded characters to keep (UTF-16, so about twice that in bytes). */
    textCacheChars = 24_000_000,
    private clock: RetryClock = retryClock,
  ) {
    this.texts = new TextCache(textCacheChars)
    this.refresh(true)
  }

  /**
   * Pick up index changes made by another connection (the indexer), or with `force` by any.
   * Returns true if anything changed. Only a rebuilt index is read again in full: otherwise
   * the catalog takes in just the files added, changed and removed since.
   */
  refresh(force = false): boolean {
    const dv = (this.db.query("PRAGMA data_version").get() as { data_version: number }).data_version
    if (!force && dv === this.dataVersion) return false
    return this.db.transaction(() => {
    this.dataVersion = dv
    this.warmOrder = null
    const gen = `${getMeta(this.db, "generation") ?? 0}:${getMeta(this.db, "schema_version")}`
    const full = gen !== this.generation
    this.revision++
    if (full) this.texts.clear()
    else {
      for (const [id] of this.db.query("SELECT id FROM files WHERE seq > ?").values(this.cacheSeq) as number[][]) this.texts.delete(id!)
      const first = (this.db.query("SELECT MIN(n) AS n FROM removed").get() as { n: number | null }).n
      if (first !== null && first > this.cacheRemoved + 1) this.texts.clear()
      else for (const [id] of this.db.query("SELECT id FROM removed WHERE n > ?").values(this.cacheRemoved) as number[][]) this.texts.delete(id!)
    }
    this.cacheSeq = Number(getMeta(this.db, "change_seq") ?? 0)
    this.cacheRemoved = (this.db.query("SELECT COALESCE(MAX(n), 0) AS n FROM removed").get() as { n: number }).n
    this.generation = gen
    this.catalog.load(this.db, !full)
    this.vocab.load(this.db, !full)
    const opens = getMeta(this.db, "frecency_seq") ?? "0"
    if (full || opens !== this.frecencySeq) {
      this.frecencySeq = opens
      this.frecency.clear()
      for (const r of this.db.query("SELECT path, count, last FROM frecency").all() as { path: string; count: number; last: number }[]) this.frecency.set(r.path, r)
      for (const o of this.unsaved) this.countOpen(o.path, o.at)
    }
    return true
    })()
  }

  /* ------------------------------------------------------------ public -- */

  async search(rawQuery: string, mode: Mode = "find", opts: SearchOptions = {}): Promise<SearchResponse> {
    if (opts.groupDuplicates && !opts.branch) return this.searchGrouped(rawQuery, mode, opts)
    const t0 = performance.now()
    this.refresh()
    const q = parseQuery(rawQuery, Date.now(), mode)
    if (opts.onlyIds) q.filters.ids = opts.onlyIds
    this.now = Date.now()
    this.lastExpansions = []
    const limit = ((opts.branch ? undefined : q.filters.limit) ?? opts.limit ?? 100) + (opts.extra ?? 0)
    const effective: Mode = q.forcedMode ?? mode
    const res: SearchResponse = { query: rawQuery, mode, resolved: effective, strategy: "", hits: [], total: 0, elapsedMs: 0, partial: false }
    if (q.warnings.length) res.notice = q.warnings.join("; ")
    try {
      const expression = effective === "semantic" ? null : booleanQuery(rawQuery)
      if (expression) return await this.searchExpression(expression, rawQuery, mode, opts, t0)
      if (!q.text && !q.phrases.length) {
        if (hasFilters(q.filters)) {
          res.strategy = "recent files matching filters"
          const idx = q.filters.sort ? Array.from({ length: this.catalog.size }, (_, i) => i).filter((i) => this.catalog.passes(i, q.filters)).sort((a, b) => this.compareIds(this.catalog.ids[a]!, this.catalog.ids[b]!, q.filters.sort!)).slice(0, limit) : this.catalog.browse(q.filters, limit)
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
      else if (effective === "semantic") await this.runSemantic(q, limit, res, opts)
      else await this.runGrep(q, limit, res, q.regex, opts)
    } catch (err) {
      res.error = (err as Error).message
    }
    if (!res.error && !res.hits.length && !q.regex && q.words.length && effective !== "semantic") {
      const alternatives = q.words.map((w) => this.vocab.similar(foldTerm(w)).find((t) => t !== foldTerm(w) && this.visibleTerm(t)) ?? w)
      if (alternatives.some((w, i) => w !== q.words[i])) res.notice = [res.notice, `Did you mean: ${alternatives.join(" ")}`].filter(Boolean).join("; ")
    }
    return this.done(res, t0)
  }

  private done(res: SearchResponse, t0: number): SearchResponse {
    const policyOpts = policyFor(crawlOptionsFor(this.config))
    const metadataQuery = usesMetadata(parseQuery(res.query, Date.now(), res.mode).filters)
    const returned = res.hits.length
    res.hits = res.hits.filter((hit) => {
      const policy = policyOpts(hit.path)
      if (!policy.allowed) return false
      const i = this.catalog.indexOf(hit.id)
      const contentAllowed = i !== undefined && this.contentAuthorized(i, policyOpts)
      if (metadataQuery && (!this.config.content.metadata || !contentAllowed)) return false
      if (!contentAllowed) {
        hit.sources = hit.sources.filter((s) => s !== "content")
        hit.lines = []; hit.matchCount = 0
        if (!hit.sources.length) return false
      }
      return true
    })
    res.total = Math.max(res.hits.length, res.total - (returned - res.hits.length))
    res.elapsedMs = performance.now() - t0
    return res
  }

  /** SHA-256 of file contents by `dev:ino:size:mtime:ctime`, oldest first: hard links share one. */
  private digests = new Map<string, string>()

  private async searchGrouped(rawQuery: string, mode: Mode, opts: SearchOptions): Promise<SearchResponse> {
    const t0 = performance.now()
    const limit = parseQuery(rawQuery, Date.now(), mode).filters.limit ?? opts.limit ?? 100
    const res = await this.search(rawQuery, mode, { ...opts, groupDuplicates: false, extra: COPY_EXTRA })
    const fetched = res.hits.length
    const rows = this.groupCopies(res.hits, performance.now() + COPY_BUDGET_MS)
    res.total = res.total > fetched ? Math.max(rows.length, res.total - (fetched - rows.length)) : rows.length
    res.hits = rows.slice(0, limit)
    res.elapsedMs = performance.now() - t0
    return res
  }

  /**
   * Fold byte-identical files into the first (best ranked) of them. Only files of a size another
   * hit has are looked at: hard links are known by their inode, other files by a SHA-256 of their
   * bytes, cached by file identity and read only where contents may be, up to COPY_MAX_BYTES.
   * Files not reached by `deadline` stay hits of their own.
   */
  private groupCopies(hits: SearchHit[], deadline: number): SearchHit[] {
    const candidate = (h: SearchHit) => !h.isDir && h.size > 0
    const sizes = new Map<number, number>()
    for (const h of hits) if (candidate(h)) sizes.set(h.size, (sizes.get(h.size) ?? 0) + 1)
    if (![...sizes.values()].some((n) => n > 1)) return hits
    const check = policyFor(crawlOptionsFor(this.config))
    const keys = new Map<number, string>()
    for (const h of hits) {
      if (performance.now() > deadline) break
      if (!candidate(h) || sizes.get(h.size)! < 2) continue
      const policy = check(h.path), i = this.catalog.indexOf(h.id)
      if (!policy.allowed || i === undefined) continue
      const path = policy.real ?? h.path
      let st: Stats
      try { st = statSync(path) } catch { continue }
      if (!st.isFile() || st.size !== h.size) continue
      const inode = `${st.dev}:${st.ino}`, identity = `${inode}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
      let digest: string | null | undefined
      if (this.contentAuthorized(i, check)) {
        digest = this.digests.get(identity)
        if (digest === undefined && h.size <= COPY_MAX_BYTES) {
          digest = fileDigest(path, st, deadline)
          if (digest) {
            this.digests.set(identity, digest)
            if (this.digests.size > COPY_DIGESTS) this.digests.delete(this.digests.keys().next().value!)
          }
        }
      }
      keys.set(h.id, digest ? `sha:${h.size}:${digest}` : `inode:${inode}`)
    }
    const groups = new Map<string, SearchHit[]>(), rows: SearchHit[][] = []
    for (const h of hits) {
      const key = keys.get(h.id), group = key === undefined ? undefined : groups.get(key)
      if (group) { group.push(h); continue }
      rows.push([h])
      if (key !== undefined) groups.set(key, rows[rows.length - 1]!)
    }
    return rows.map(([first, ...rest]) => (rest.length ? { ...first!, copies: rest.map((h) => ({ id: h.id, path: h.path, display: h.display, mtime: h.mtime })) } : first!))
  }

  private contentAuthorized(i: number, check = policyFor(crawlOptionsFor(this.config))): boolean {
    if (!this.config.content.enabled) return false
    const policy = check(this.catalog.paths[i]!)
    return policy.allowed && policy.content && (!this.catalog.sourcePaths.has(this.catalog.ids[i]!) || this.catalog.sourcePaths.get(this.catalog.ids[i]!) === policy.real)
  }

  private visibleTerm(term: string): boolean {
    if (!this.config.content.enabled) return false
    const opts = policyFor(crawlOptionsFor(this.config))
    try {
      for (const [id] of this.db.query("SELECT rowid FROM fts WHERE fts MATCH ?").values(`body : ${ftsTerm(term)}`) as number[][]) {
        const i = this.catalog.indexOf(id)
        if (i !== undefined && this.contentAuthorized(i, opts)) return true
      }
    } catch {}
    return false
  }

  private compareIds(a: number, b: number, sort: string): number {
    const ia = this.catalog.indexOf(a), ib = this.catalog.indexOf(b)
    if (ia === undefined || ib === undefined) return 0
    const c = this.catalog, key = sort.replace(/^-/, ""), sign = sort.startsWith("-") ? -1 : 1
    const order = key === "size" ? c.sizes[ia]! - c.sizes[ib]! : key === "date" ? c.mtimes[ia]! - c.mtimes[ib]! : key === "name" ? c.paths[ia]!.slice(c.paths[ia]!.lastIndexOf("/") + 1).localeCompare(c.paths[ib]!.slice(c.paths[ib]!.lastIndexOf("/") + 1)) : c.paths[ia]!.localeCompare(c.paths[ib]!)
    return sign * order || c.paths[ia]!.localeCompare(c.paths[ib]!)
  }

  private async searchExpression(expr: QueryExpression, query: string, mode: Mode, opts: SearchOptions, started: number): Promise<SearchResponse> {
    if (expr.op === "leaf") { const res = await this.search(expr.text, mode, opts); res.query = query; return res }
    const deadline = performance.now() + (opts.budgetMs ?? 2500)
    const revision = this.revision, config = this.config
    const result = await this.evaluateGroup(expr, mode, opts, deadline)
    if (this.revision !== revision || this.config !== config) return this.done({ query, mode, resolved: mode, strategy: "grouped search interrupted", hits: [], total: 0, elapsedMs: 0, partial: true }, started)
    const filters = parseQuery(query, Date.now(), mode).filters
    const hits = [...result.hits.values()].sort((a, b) => filters.sort ? this.compareIds(a.id, b.id, filters.sort) : b.score - a.score)
    const notice = [...new Set(result.notices)].join("; ")
    return this.done({
      query, mode, resolved: mode, strategy: "grouped search",
      total: result.total,
      hits: hits.slice(0, (filters.limit ?? opts.limit ?? 100) + (opts.extra ?? 0)),
      elapsedMs: 0,
      partial: !result.complete,
      error: result.error,
      ...(notice ? { notice } : {}),
    }, started)
  }

  /**
   * Each part of a group keeps at most BRANCH_LIMIT hits, so intersecting them as they come
   * would lose files (`type:pdf` alone lists only the newest PDFs). The parts of an AND are
   * narrowed instead to the smallest one that has all its matches, and run again within it.
   */
  private async evaluateGroup(expr: QueryExpression, mode: Mode, opts: SearchOptions, deadline: number): Promise<GroupPart> {
    if (expr.op === "leaf") {
      const r = await this.search(expr.text, mode, { ...opts, limit: BRANCH_LIMIT, branch: true, budgetMs: Math.max(1, deadline - performance.now()) })
      return {
        hits: new Map(r.hits.map((h) => [h.id, h])),
        complete: !r.partial && !r.error && r.total <= r.hits.length && r.hits.length < BRANCH_LIMIT,
        total: r.total,
        notices: r.notice ? [r.notice] : [],
        error: r.error,
      }
    }
    const parts: GroupPart[] = []
    for (const part of expr.parts) parts.push(await this.evaluateGroup(part, mode, opts, deadline))
    if (expr.op === "and") {
      const seed = parts.filter((p) => p.complete).sort((a, b) => a.hits.size - b.hits.size)[0]
      if (seed) {
        const within = new Set(seed.hits.keys())
        for (const [k, p] of parts.entries()) {
          if (p.complete) continue
          parts[k] = within.size ? await this.evaluateGroup(expr.parts[k]!, mode, { ...opts, onlyIds: within }, deadline) : { hits: new Map(), complete: true, total: 0, notices: [] }
        }
      }
    }
    const notices = parts.flatMap((p) => p.notices)
    const error = parts.find((p) => p.error)?.error
    const complete = parts.every((p) => p.complete)
    const hits = new Map<number, SearchHit>()
    for (const [n, part] of parts.entries()) {
      for (const h of part.hits.values()) {
        const old = hits.get(h.id)
        if (!old) { if (expr.op === "or" || n === 0) hits.set(h.id, structuredClone(h)); continue }
        // Matched by several parts: it matches more of the query.
        old.score += h.score
        old.sources = [...new Set([...old.sources, ...h.sources])]
        for (const l of h.lines) if (!old.lines.some((o) => o.line === l.line)) old.lines.push(l)
      }
    }
    if (expr.op === "and") for (const id of hits.keys()) if (parts.some((p) => !p.hits.has(id))) hits.delete(id)
    const total = complete || expr.op === "and" ? hits.size : Math.max(hits.size, ...parts.map((p) => p.total))
    return { hits, complete, total, notices, error }
  }

  /* ---------------------------------------------------------- strategy -- */

  private async runFuzzy(q: ParsedQuery, limit: number, res: SearchResponse) {
    const query = fuzzyQueryText(q)
    // A requested order applies to every match (`fuse` picks the first), not to the most relevant
    // few. Name highlights are then worked out for the hits shown only.
    const sorted = !!q.filters.sort
    const keep = sorted ? Math.max(this.catalog.size, limit) : limit
    const names = this.nameMatches(q, keep, 0, !sorted)
    const lists: { name: string; weight: number; items: Ranked[]; source: Source }[] = [{ name: "names", weight: 1.3, items: names, source: "name" }]
    if (names.length < limit / 4) {
      const typo = this.catalog.typo(query, q.filters, keep).map((m) => ({ id: this.catalog.ids[m.idx]!, positions: m.positions }))
      lists.push({ name: "typo", weight: 0.9, items: typo, source: "name" })
    }
    // fzf operators ('exact ^prefix suffix$ !not) are about names only.
    const operators = parseFuzzyTerms(query).some((t) => t.kind !== "fuzzy" || t.negate)
    if (!operators) lists.push({ name: "text", weight: 0.6, items: this.keywordMatches(q, limit, q.typing, true, keep), source: "content" })
    res.strategy = operators ? "fuzzy names" : "fuzzy names + typo-tolerant text"
    const positions = (id: number) => {
      const i = this.catalog.indexOf(id)
      return i === undefined ? undefined : this.catalog.positions(i, query)
    }
    this.fuse(lists, limit, res, q, false, sorted ? positions : undefined)
  }

  /* ---------------------------------------------------------- semantic -- */

  /** Granite vectors and query helper, loaded on the first semantic search. */
  private vectors: SemanticVectors | null = null
  private queryEmbedder: QueryEmbedder | null = null
  /** Tests and benchmarks may supply query vectors; null disables the model. */
  embedQuery: ((text: string) => Promise<Float32Array>) | null | undefined

  private queryVectorFn(): ((text: string) => Promise<Float32Array>) | null {
    if (this.embedQuery !== undefined) return this.embedQuery
    if (!this.queryEmbedder) {
      const tool = embedToolPath()
      const files = installedModel(GRANITE)
      if (!tool || !files) return null
      this.queryEmbedder = new QueryEmbedder(() => new Embedder({ tool, model: files[0]!, pooling: "cls", threads: Math.min(4, availableParallelism()), batchTokens: 2048, maxSeqs: 16 }))
      if (this.keepSemantic) this.queryEmbedder.idleMs = Infinity
    }
    return (text) => this.queryEmbedder!.embed(text)
  }

  private keepSemantic = false

  /** Keep the query model running while idle (see `warmSemantic`), rather than stop it after two minutes. */
  keepSemanticReady() {
    this.keepSemantic = true
    if (this.queryEmbedder) this.queryEmbedder.idleMs = Infinity
  }

  /**
   * Start the query model and load the vectors, if semantic search is on and ready, so that the
   * next semantic search waits for neither. Loads the vectors again if the semantic index changed.
   */
  async warmSemantic(): Promise<void> {
    if (!this.config.semantic.enabled || !this.config.content.enabled || !this.db.filename) return
    if (this.embedQuery === undefined && !installedModel(GRANITE)) return
    const fingerprint = this.vectorFingerprint(embedToolPath())
    if (fingerprint === null) return
    const vectors = (this.vectors ??= new SemanticVectors(semanticDbPath(this.db.filename)))
    const index = vectors.get(mainGeneration(this.db), getMeta(this.db, "change_seq") ?? "0", fingerprint)
    if (!index?.size || this.embedQuery !== undefined || !this.queryVectorFn()) return
    await this.queryEmbedder!.warm()
  }

  /**
   * The helper's vector version, read once per helper binary: reading it starts the helper, and
   * can block for seconds. A failed read is tried again after HELPER_RETRY_MS, not on every search.
   */
  private helperVersion: { tool: string; stamp: string; version: number | null; at: number } | null = null

  /**
   * The fingerprint stored vectors must have to compare with query vectors (see
   * `semanticFingerprint`); null if the helper's version can't be read. Vectors supplied by
   * `embedQuery` come from no helper here: undefined, nothing to check.
   */
  private vectorFingerprint(tool: string | null): string | null | undefined {
    if (this.embedQuery !== undefined) return undefined
    if (!tool) return null
    let stamp: string
    try {
      const s = statSync(tool)
      stamp = `${s.ino}:${s.size}:${s.mtimeMs}`
    } catch {
      return null
    }
    const known = this.helperVersion
    if (known?.tool !== tool || known.stamp !== stamp || (known.version === null && Date.now() - known.at >= HELPER_RETRY_MS)) {
      this.helperVersion = { tool, stamp, version: helperVectorVersion(tool), at: Date.now() }
    }
    const version = this.helperVersion!.version
    return version === null ? null : semanticFingerprint(version)
  }

  /**
   * The Granite snapshot semantic search may use now: complete for the files as they are, and
   * made by the model and helper that embed queries. Otherwise why not (`waiting`: for a pass).
   */
  private semanticIndex(): { index: VectorIndex } | { notice: string; waiting?: boolean } {
    if (!this.config.semantic.enabled) return { notice: "Semantic search is off: turn it on with `zsearch semantic install` (or in the app's settings). Showing word matches" }
    if (!this.config.content.enabled) return { notice: "Semantic search needs file contents, which are off" }
    const tool = embedToolPath()
    const modelReady = this.embedQuery !== undefined ? !!this.embedQuery : !!installedModel(GRANITE)
    const helperReady = this.embedQuery !== undefined ? !!this.embedQuery : !!tool
    if (!modelReady) return { notice: "Semantic search needs its model: run `zsearch semantic install`. Showing word matches" }
    if (!helperReady) return { notice: "Semantic search needs the embedding helper (zsearch-embed). Showing word matches" }
    const fingerprint = this.vectorFingerprint(tool)
    if (fingerprint === null) return { notice: "Semantic search could not read the embedding helper's version (zsearch-embed --version). Showing word matches" }
    const sequence = getMeta(this.db, "change_seq") ?? "0"
    const vectors = (this.vectors ??= new SemanticVectors(semanticDbPath(this.db.filename || ":memory:")))
    const index = vectors.get(mainGeneration(this.db), sequence, fingerprint)
    if (!index?.size || !index.isCompleteFor(sequence)) return { notice: "Granite is not ready for the current files: semantic indexing finishes with the next index update. Showing word matches", waiting: true }
    return { index }
  }

  /** Which passages of a snapshot the user may read by content (1), for the settings and index as they are. */
  private allowedRows: { index: VectorIndex; config: Config; revision: number; rows: Uint8Array } | null = null

  private authorizedRows(index: VectorIndex): Uint8Array {
    const cached = this.allowedRows
    if (cached?.index === index && cached.config === this.config && cached.revision === this.revision) return cached.rows
    const check = policyFor(crawlOptionsFor(this.config))
    const byFile = new Map<number, number>()
    const rows = new Uint8Array(index.size)
    for (let row = 0; row < rows.length; row++) {
      const file = Math.abs(index.file[row]!)
      let ok = byFile.get(file)
      if (ok === undefined) {
        const i = this.catalog.indexOf(file)
        byFile.set(file, (ok = i !== undefined && this.contentAuthorized(i, check) ? 1 : 0))
      }
      rows[row] = ok
    }
    this.allowedRows = { index, config: this.config, revision: this.revision, rows }
    return rows
  }

  /** How semantic results are put together (benchmarks try others). */
  ranking: Ranking = RANKING

  /** Stop the query models and let go of the vectors (the worker is shutting down, or idle). */
  closeSemantic() {
    this.queryEmbedder?.close()
    this.queryEmbedder = null
    this.vectors?.close()
    this.vectors = null
    this.allowedRows = null
  }

  /**
   * Semantic search with finite word, filename and model evidence: files whose best passage
   * stands out for the query, and files holding at least half of its words. Without the model, or
   * before files have vectors, only the words count, and a notice says why.
   */
  private async runSemantic(q: ParsedQuery, limit: number, res: SearchResponse, opts: SearchOptions) {
    const notices: string[] = []
    const text = [...q.words, ...q.phrases].join(" ")
    const cat = this.catalog
    let check = policyFor(crawlOptionsFor(this.config))
    const usable = (id: number): number | undefined => {
      const i = cat.indexOf(id)
      return i !== undefined && cat.passes(i, q.filters) && !cat.isDir[i] && !semanticExcluded(cat.paths[i]!) ? i : undefined
    }

    // Query only a complete, current Granite snapshot. Words remain available during indexing.
    let best = new Map<number, { z: number; row: number; index: VectorIndex }>()
    // The helper embeds the query in its own process while the words below are looked up.
    let embedding: Promise<Float32Array> | null = null
    const snapshot = this.semanticIndex()
    if (!("index" in snapshot)) {
      if (!snapshot.waiting || text.trim()) notices.push(snapshot.notice)
    } else if (text.trim()) {
      const embed = this.queryVectorFn()!
      let vector: Promise<Float32Array>
      try { vector = embed(text) } catch (err) { vector = Promise.reject(err) }
      vector.catch(() => {})
      embedding = vector
    }

    // Words: the share of the query's words each file holds, in its name or folders, or its text.
    const terms = queryTerms(text)
    const coverage = new Map<number, number>()
    const named = new Map<number, number>()
    const nameMatch = new Set<number>()
    const bodyMatch = new Set<number>()
    const matching = (column: string, term: string, prefix: boolean): number[] => {
      try {
        // The same expression find builds for a word, so the index's way of keeping words applies.
        const fts = this.ftsWords([term], prefix)
        const ids = (this.db.query("SELECT rowid FROM fts WHERE fts MATCH ?").values(`${column} : ${fts.expr}`) as number[][]).map((r) => r[0]!)
        if (!fts.broad) return ids
        // A prefix many long words share matches by their first characters only: check the rest.
        const check = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}`, "iu")
        return ids.filter((id) => {
          if (column !== "body") {
            const i = this.catalog.indexOf(id)
            return i !== undefined && check.test(this.catalog.paths[i]!)
          }
          const stored = this.storedText(id)
          return stored !== null && check.test(stored)
        })
      } catch {
        return []
      }
    }
    const contentOk = new Map<number, boolean>()
    const canRead = (id: number, i: number) => {
      let ok = contentOk.get(id)
      if (ok === undefined) contentOk.set(id, (ok = this.contentAuthorized(i, check)))
      return ok
    }
    const readable = (id: number) => {
      const i = cat.indexOf(id)
      return i !== undefined && canRead(id, i)
    }
    // Each word's files: by name or folders, and (not yet checked for content authorization) by text alone.
    const byName: Set<number>[] = []
    const byText: Set<number>[] = []
    // Words after `-` or `!` rule a file out.
    const negatedNames = new Set<number>()
    const negatedText = new Set<number>()
    const lookUpWords = () => {
      byName.length = 0
      byText.length = 0
      nameMatch.clear()
      named.clear()
      negatedNames.clear()
      negatedText.clear()
      terms.forEach((term, t) => {
        // Endings count as the same word ("invoices", "invoice"), as DigUp's stemmed index has it.
        const stem = stemOf(term)
        const prefix = stem !== term || (q.typing && t === terms.length - 1)
        const names = new Set<number>()
        for (const id of matching("{name dirs}", stem, prefix)) if (usable(id) !== undefined) { names.add(id); nameMatch.add(id); named.set(id, (named.get(id) ?? 0) + 1 / terms.length) }
        const body = new Set<number>()
        if (this.config.content.enabled) for (const id of matching("body", stem, prefix)) if (!names.has(id) && usable(id) !== undefined) body.add(id)
        byName.push(names)
        byText.push(body)
      })
      for (const n of q.negated.flatMap((w) => foldTerm(w).match(/[\p{L}\p{N}]+/gu) ?? [])) {
        for (const id of matching("{name dirs}", n, false)) negatedNames.add(id)
        // Only text the user may read rules a file out: otherwise which files are left would tell its words.
        if (this.config.content.enabled) for (const id of matching("body", n, false)) if (readable(id)) negatedText.add(id)
      }
    }
    const revision = this.revision
    const config = this.config
    lookUpWords()

    if (embedding) {
      let vector: Float32Array | null = null
      try {
        vector = await embedding
      } catch (err) {
        notices.push(`Semantic search failed (${(err as Error).message}). Showing word matches`)
      }
      if (vector && opts.cancelled?.()) { res.partial = true; res.strategy = "semantic"; return }
      // The worker may have taken in an index update or new settings while the query was
      // embedded: the words found before it would match files by text they no longer hold, and
      // only a Granite snapshot of the files as they are now may answer.
      if (this.config !== config) { check = policyFor(crawlOptionsFor(this.config)); contentOk.clear() }
      if (this.revision !== revision || this.config !== config) lookUpWords()
      if (vector) {
        const now = this.semanticIndex()
        if ("index" in now) {
          const index = now.index
          // Passages the user may not read by content neither match nor set the scale of the others' scores.
          const allowed = this.authorizedRows(index)
          best = bestByFile(index, meaning(index.score(vector), index.modality, index.setsScale.map((s, row) => s & allowed[row]!)), (file) => usable(file) !== undefined, this.ranking, allowed)
        } else notices.push(now.notice)
      }
    }
    for (const id of negatedNames) best.delete(id)
    for (const id of negatedText) best.delete(id)
    const zGate = this.ranking.zGate ?? Z_GATE

    const weighted = new Map<number, number>()
    if (best.size && !(this.ranking.strength > 0)) {
      // Only candidates' coverage counts: files that stand out by meaning, and files that could
      // hold enough of the words (counting text matches the user may not read, as an upper bound).
      const gate = this.ranking.words > 0 ? coverageGate(this.ranking, true, terms.length) : Infinity
      const share = new Map<number, number>()
      for (let t = 0; t < terms.length; t++) for (const set of [byName[t]!, byText[t]!]) for (const id of set) share.set(id, (share.get(id) ?? 0) + 1)
      const candidate = new Set<number>()
      for (const [id, n] of share) if (n / terms.length >= gate - 1e-9) candidate.add(id)
      for (const [file, b] of best) if (b.z >= zGate) candidate.add(file)
      // Rare words count for more, as without vectors. Only text the user may read counts: otherwise
      // a names-only folder's contents would shift visible files' order and give its words away.
      const idf = terms.map((_, t) => {
        let n = byName[t]!.size
        for (const id of byText[t]!) if (readable(id)) n++
        return Math.log(1 + Math.max(cat.paths.length, 1) / Math.max(n, 1))
      })
      const idfTotal = idf.reduce((a, b) => a + b, 0) || 1
      const add = (id: number, t: number) => { coverage.set(id, (coverage.get(id) ?? 0) + 1 / terms.length); weighted.set(id, (weighted.get(id) ?? 0) + idf[t]! / idfTotal) }
      for (let t = 0; t < terms.length; t++) {
        for (const id of byName[t]!) if (candidate.has(id)) add(id, t)
        for (const id of byText[t]!) if (candidate.has(id) && readable(id)) { bodyMatch.add(id); add(id, t) }
      }
    } else {
      const sets = terms.map((_, t) => {
        const has = new Set(byName[t])
        for (const id of byText[t]!) if (readable(id)) { has.add(id); bodyMatch.add(id) }
        return has
      })
      // Without vectors, rare words count for more of a file's coverage (whether it matches at all still counts words).
      const idf = sets.map((h) => Math.log(1 + Math.max(cat.paths.length, 1) / Math.max(h.size, 1)))
      const idfTotal = idf.reduce((a, b) => a + b, 0) || 1
      sets.forEach((has, t) => { for (const id of has) { coverage.set(id, (coverage.get(id) ?? 0) + 1 / terms.length); weighted.set(id, (weighted.get(id) ?? 0) + idf[t]! / idfTotal) } })
    }
    for (const id of negatedNames) { coverage.delete(id); weighted.delete(id); named.delete(id) }
    for (const id of negatedText) { coverage.delete(id); weighted.delete(id) }

    // Among word matches, keyword search's own order (how often and where the words are), when the ranking uses it.
    const strength = new Map<number, number>()
    if ((best.size ? this.ranking.strength : (this.ranking.keywordStrength ?? this.ranking.strength)) > 0 && coverage.size) {
      // Content words only: stopwords would let a long query's filler decide the order.
      const kw = this.keywordMatches({ ...parseQuery(terms.join(" ")), filters: q.filters }, Math.min(coverage.size, 2000), q.typing)
      const top = kw.reduce((m, r) => Math.max(m, r.raw ?? 0), 0)
      if (top > 0) for (const r of kw) if (coverage.has(r.id)) strength.set(r.id, (r.raw ?? 0) / top)
    }
    const ranked = rank({
      best,
      coverage,
      named,
      strength,
      ranking: this.ranking,
      terms: terms.length,
      weighted,
      lookup: isLookup(terms),
      wordWeight: WORD_WEIGHT,
      hinted: kindHints(text),
      kindOf: (file) => { const i = cat.indexOf(file); return i === undefined ? undefined : cat.kinds[i] },
    })
    // Code's word evidence counts half as much as prose. Compute its stage weight once.
    const codeCoverage = isLookup(terms) ? 1 : best.size ? (this.ranking.coverage ?? 1) : (this.ranking.keywordCoverage ?? 1)
    const codeWordWeight = this.ranking.words * codeCoverage * (isLookup(terms) ? 2 : 1)
    const shares = wordShares(this.ranking, best.size > 0, isLookup(terms), coverage, weighted)
    for (const r of ranked) {
      const i = cat.indexOf(r.file)
      if (i !== undefined && (cat.kinds[i] === "code" || cat.kinds[i] === "data")) r.score -= (WORD_WEIGHT - CODE_WORD_WEIGHT) * codeWordWeight * (shares.get(r.file) ?? 0) ** 1.5
    }
    if (q.filters.sort) ranked.sort((a, b) => this.compareIds(a.file, b.file, q.filters.sort!))
    else ranked.sort((a, b) => b.score - a.score || a.file - b.file)
    res.total = ranked.length
    res.strategy = best.size ? "semantic + words" : "words"
    if (notices.length) res.notice = [res.notice, ...notices].filter(Boolean).join("; ")
    const pattern = termsPattern(q.words, q.phrases, q.typing)
    res.hits = ranked.slice(0, limit).map((r, n) => {
      const sources: Source[] = []
      if (r.row !== null || bodyMatch.has(r.file)) sources.push("content")
      if (nameMatch.has(r.file)) sources.push("name")
      const h = this.hit(r.file, r.score, sources.length ? sources : ["content"])
      if (n >= SNIPPET_HITS) return h
      // A saved-name lookup needs the document's heading, not an arbitrary semantic passage
      // deep inside it (e.g. a conduct paragraph for "handbook"). Keep content authorization.
      if (terms.length && (named.get(r.file) ?? 0) >= 1 - 1e-9) {
        const i = cat.indexOf(r.file)
        if (i !== undefined && canRead(r.file, i)) {
          const text = this.storedText(r.file)
          if (text !== null) {
            h.lines = passageLines(text, 0, Math.min(text.length, 1800), null)
            h.matchCount = h.lines.length
            return h
          }
        }
      }
      // Show the passage that matched by meaning; or, matched by words, the lines with them.
      const index = r.row !== null ? best.get(r.file)!.index : undefined
      const strong = r.z! >= 2
      const useMeaning = r.row !== null && index && (strong || !bodyMatch.has(r.file)) && index.start[r.row]! >= 0
      if (useMeaning) {
        const t = this.storedText(r.file)
        if (t !== null) {
          h.lines = passageLines(t, index.start[r.row!]!, index.end[r.row!]!, pattern)
          h.matchCount = h.lines.length
        }
      } else if (pattern && bodyMatch.has(r.file)) {
        const s = this.snippets(r.file, pattern)
        h.lines = s.lines
        h.matchCount = s.count
      }
      return h
    })
  }

  /* ------------------------------------------------------------- names -- */

  private nameMatches(q: ParsedQuery, limit: number, minQuality: number, withPositions = true): Ranked[] {
    const query = fuzzyQueryText(q)
    if (!query.trim()) return []
    const terms = parseFuzzyTerms(query).filter((t) => !t.negate)
    const ideal = terms.reduce((s, t) => s + 22 * t.text.length + 24, 0)
    const raw = this.catalog.fuzzy(query, q.filters, Math.max(limit * 2, 100), (i) => this.bias(i), withPositions)
    return raw
      .filter((m) => minQuality === 0 || m.score >= ideal * minQuality)
      .slice(0, limit)
      .map((m) => ({ id: this.catalog.ids[m.idx]!, positions: withPositions ? m.positions : undefined, raw: m.score }))
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
    const cat = this.catalog
    const frecent: number[] = []
    if (this.frecency.size) for (let i = 0; i < cat.size; i++) if (this.frecency.has(cat.paths[i]!)) frecent.push(i)
    frecent.sort((a, b) => this.frecency.get(cat.paths[b]!)!.last - this.frecency.get(cat.paths[a]!)!.last)
    frecent.length = Math.min(frecent.length, Math.min(limit, 20))
    const seen = new Set(frecent)
    const newest = cat.newest(limit - frecent.length, (i) => !cat.isDir[i] && !seen.has(i))
    return [...frecent, ...newest].map((i) => this.hit(cat.ids[i]!, 0, ["name"]))
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
      const fts = this.ftsWords(tokens, prefix)
      let expr = fts.expr
      const terms = [...tokens]
      if (typos && tokens.length === 1) {
        const t = tokens[0]!
        const alts = new Set<string>([...this.vocab.similar(t)])
        if (t.length >= 4) for (const c of this.vocab.containing(t, 40) ?? []) alts.add(c)
        alts.delete(t)
        const some = [...alts].slice(0, 48)
        this.lastExpansions.push(...some)
        terms.push(...some)
        if (some.length) expr = `(${[expr, ...some.map(ftsTerm)].join(" OR ")})`
      }
      // The broad prefix is the last token's; a typo's alternatives count as the word too.
      let check: RegExp | undefined
      if (fts.broad) {
        const alts = terms.slice(tokens.length).map(escapeRegExp)
        const whole = alts.length ? `|(?:${alts.join("|")})(?![\\p{L}\\p{N}])` : ""
        check = new RegExp(`(?<![\\p{L}\\p{N}])(?:${escapeRegExp(tokens[tokens.length - 1]!)}${whole})`, "iu")
      }
      groups.push({ expr, terms, prefix, check })
    })
    for (const p of q.phrases) {
      const tokens = foldTerm(p).match(/[\p{L}\p{N}]+/gu)
      if (tokens) groups.push({ expr: this.ftsWords(tokens, false).expr, terms: tokens, prefix: false })
    }
    return groups
  }

  /** One FTS5 expression for the groups: all of them (or `any`), minus the negated words. */
  private groupsExpr(q: ParsedQuery, groups: TermGroup[], any: boolean): string | null {
    if (!groups.length) return null
    let expr = groups.map((g) => g.expr).join(any ? " OR " : " AND ")
    const neg = q.negated.flatMap((n) => foldTerm(n).match(/[\p{L}\p{N}]+/gu) ?? []).map(ftsTerm)
    if (neg.length) expr = `(${expr}) NOT (${neg.join(" OR ")})`
    return expr
  }

  /** All of `tokens` (the index keeps no word positions, so a phrase is matched as its words), the last one optionally as a prefix. */
  private ftsWords(tokens: string[], prefixLast: boolean): { expr: string; broad: boolean } {
    let broad = false
    const quoted = tokens.map((t, i) => {
      if (!prefixLast || i < tokens.length - 1) return ftsTerm(t)
      const p = ftsPrefixExpr(t, (p) => this.vocab.longStartingWith(p))
      broad = p.broad
      return p.expr
    })
    return { expr: quoted.length === 1 ? quoted[0]! : `(${quoted.join(" AND ")})`, broad }
  }

  /** The `limit` best matches, or `keep` of them with only the `limit` best (at least RANK_POOL) ranked by their text. */
  private keywordMatches(q: ParsedQuery, limit: number, prefixLast: boolean, typos = false, keep = limit): Ranked[] {
    const groups = this.keywordGroups(q, prefixLast, typos)
    const ids = (expr: string | null): number[] => {
      if (!expr) return []
      try {
        return (this.db.query("SELECT rowid FROM fts WHERE fts MATCH ?").values(expr) as number[][]).map((r) => r[0]!)
      } catch {
        return []
      }
    }
    // A group whose expression also matches other words holds only where its path or text has the word.
    const holds = (id: number, g: TermGroup) => {
      if (!g.check) return true
      const i = this.catalog.indexOf(id)
      if (i !== undefined && g.check.test(this.catalog.paths[i]!)) return true
      const text = this.storedText(id)
      return text !== null && g.check.test(text)
    }
    const checked = groups.some((g) => g.check)
    let matches = ids(this.groupsExpr(q, groups, false))
    if (checked) matches = matches.filter((id) => groups.every((g) => holds(id, g)))
    // Several words but no document has all of them: fall back to any of them.
    if (matches.length === 0 && groups.length > 1) {
      matches = ids(this.groupsExpr(q, groups, true))
      if (checked) {
        const plain = groups.filter((g) => !g.check)
        const byPlain = new Set(plain.length ? ids(this.groupsExpr(q, plain, true)) : [])
        matches = matches.filter((id) => byPlain.has(id) || groups.some((g) => g.check && holds(id, g)))
      }
    }
    return this.rankMatches(matches, groups, q.filters, limit, keep)
  }

  /**
   * Order full-text matches by relevance, BM25 style. The index keeps which columns hold a term
   * but not how often (contentless, detail=column), which leaves FTS5's bm25() with nothing to
   * score, so this scores the file name and folders from the path, and the text itself for the
   * RANK_POOL best candidates by path score, then date.
   */
  private rankMatches(ids: number[], groups: TermGroup[], filters: Filters, limit: number, keep = limit): Ranked[] {
    const cat = this.catalog
    const check = policyFor(crawlOptionsFor(this.config))
    const idx: number[] = []
    for (const id of ids) {
      const i = cat.indexOf(id)
      if (i !== undefined && cat.passes(i, filters) && this.contentAuthorized(i, check)) idx.push(i)
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
    return [...pool, ...idx.slice(pool.length)].slice(0, keep).map((i) => ({ id: cat.ids[i]!, raw: score.get(i) ?? 0 }))
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
    const text = isRegex ? q.text : q.text.replace(/"([^"]*)"/g, "$1")
    const ci = q.regexFlags.includes("i") || q.caseMode === false || (q.caseMode !== true && !smartCaseSensitive(text))
    let source = isRegex ? text : q.all ? [...q.words, ...q.phrases].map(escapeRegExp).join("|") : escapeRegExp(text)
    if (q.near !== undefined && q.words.length > 1) source = q.words.map(escapeRegExp).join(`(?:[^\\p{L}\\p{N}]+[\\p{L}\\p{N}]+){0,${q.near}}[^\\p{L}\\p{N}]+`)
    if (q.wholeWord) source = `(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`
    if (q.diacritics === false && !isRegex) source = diacriticPattern(source)
    let re: RegExp
    try {
      re = new RegExp(source, [...new Set(`gm${q.wholeWord || q.near !== undefined || q.diacritics === false ? "u" : ""}${ci ? "i" : ""}${q.regexFlags}`)].join(""))
    } catch {
      try {
        re = new RegExp(source, [...new Set(`gmu${ci ? "i" : ""}${q.regexFlags}`)].join(""))
      } catch (err) {
        throw new Error(`invalid regex: ${(err as Error).message.replace(/^Invalid regular expression: /, "")}`)
      }
    }
    const req = q.diacritics === false ? regexRequirements(source, ci) : isRegex ? regexRequirements(source, ci) : q.all ? { t: "and" as const, items: [...q.words, ...q.phrases].map((w) => literalRequirement(w, ci)) } : literalRequirement(text, ci)
    return { re, req, ci }
  }

  private async runGrep(q: ParsedQuery, limit: number, res: SearchResponse, isRegex: boolean, opts: SearchOptions) {
    let policyOpts = policyFor(crawlOptionsFor(this.config))
    const revision = this.revision
    const configAtStart = this.config
    const { re, req } = this.buildRegex(q, isRegex)
    const budget = opts.budgetMs ?? 2500
    const deadline = Date.now() + budget
    // Names first: regex over the displayed path.
    const allParts = q.all && q.near === undefined ? [...q.words, ...q.phrases].map((w) => new RegExp(q.diacritics === false ? diacriticPattern(escapeRegExp(w)) : escapeRegExp(w), re.flags.replace("g", ""))) : []
    const nameSource = allParts.length ? allParts.map((p) => `(?=[\\s\\S]*${p.source})`).join("") + "[\\s\\S]*" : re.source
    const nameRe = new RegExp(nameSource, re.flags.replace("g", "").replace("m", ""))
    const nameHits = this.catalog.regex(nameRe, q.filters, q.filters.sort ? this.catalog.size : Math.max(limit * 5, 100)).filter((m) => policyOpts(this.catalog.paths[m.idx]!).allowed)
    if (q.filters.sort) nameHits.sort((a, b) => this.compareIds(this.catalog.ids[a.idx]!, this.catalog.ids[b.idx]!, q.filters.sort!))
    if (nameHits.length > limit) nameHits.length = limit
    const sampleLimit = Math.max(limit * 5, 100)
    const best = new TopK<Ranked>(sampleLimit, (h) => h.count ?? 0, q.filters.sort ? (a, b) => -this.compareIds(a.id, b.id, q.filters.sort!) : undefined)
    let matched = 0
    const expr = reqToFts(req, this.vocab)
    let scanned = 0
    let candidates = 0
    const check = (id: number, text: string): boolean => {
      scanned++
      if (allParts.some((part) => !part.test(text))) return false
      const { lines, count } = findLines(text, re, 20, 10_000, deadline)
      if (count > 0) { matched++; best.add({ id, lines, count }) }
      return !q.filters.sort && matched >= sampleLimit
    }
    if (expr !== "__no_match__") {
      // Candidate ids from FTS alone (no join), then filtered and ordered newest first with the
      // in-memory catalog: several times faster than letting SQLite join and sort.
      let ids: number[]
      try {
        ids = expr ? (this.db.query("SELECT rowid FROM fts WHERE fts MATCH ?").values(`body : (${expr})`) as number[][]).map((r) => r[0]!) : Array.from(this.catalog.ids.subarray(0, this.catalog.size))
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
      let lastYield = Date.now()
      // Texts are read in batches: one query per 64 files instead of one per file.
      scan: for (let start = 0; start < idx.length; start += FETCH_BATCH) {
        const batch = idx.slice(start, start + FETCH_BATCH).filter((i) => this.contentAuthorized(i, policyOpts)).map((i) => cat.ids[i]!)
        candidates += batch.length
        const texts = this.batchTexts(batch)
        for (const id of batch) {
          const text = texts.get(id)
          if (text !== undefined && check(id, text)) {
            res.partial = start + FETCH_BATCH < idx.length || id !== batch.at(-1)
            break scan
          }
        }
        const now = Date.now()
        if (now > deadline) {
          res.partial = true
          break
        }
        if (now - lastYield > 40) {
          // Let newer requests in; abandon this scan if one superseded it.
          await new Promise((r) => setImmediate(r))
          // Ignore files and aliases may have changed while another request ran.
          policyOpts = policyFor(crawlOptionsFor(this.config))
          lastYield = Date.now()
          if (opts.cancelled?.() || revision !== this.revision || this.config !== configAtStart) {
            res.partial = true
            break
          }
        }
      }
    }
    res.strategy = `${isRegex ? "regex" : "exact text"} ${expr ? "(indexed)" : "(full scan)"} · ${scanned.toLocaleString("en-US")} of ${candidates.toLocaleString("en-US")} files read`
    if (revision !== this.revision || this.config !== configAtStart) { res.partial = true; return }
    const contentHits = best.values()
    const lists: { name: string; weight: number; items: Ranked[]; source: Source }[] = [
      { name: "names", weight: 1, items: nameHits.map((m) => ({ id: this.catalog.ids[m.idx]!, positions: m.positions })), source: "name" },
      { name: "content", weight: 1, items: contentHits, source: "content" },
    ]
    this.fuse(lists, limit, res, q, true)
    // A file can match by name and by content: count it once.
    const ids = new Set([...nameHits.map((m) => this.catalog.ids[m.idx]!), ...contentHits.map((h) => h.id)])
    res.total = Math.max(res.total, ids.size, matched)
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

  /**
   * Reciprocal-rank fusion of several ranked lists, then snippets for the winners.
   * `namePositions`: highlights for the hits shown, when the lists' items have none of their own yet.
   */
  private fuse(lists: { name: string; weight: number; items: Ranked[]; source: Source }[], limit: number, res: SearchResponse, q: ParsedQuery, keepLines = false, namePositions?: (id: number) => number[] | undefined) {
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
    const policyOpts = policyFor(crawlOptionsFor(this.config))
    const metadataQuery = usesMetadata(q.filters)
    let top = ranked.filter(({ id, e }) => {
      const i = this.catalog.indexOf(id)
      if (i === undefined) return false
      const policy = policyOpts(this.catalog.paths[i]!)
      if (!policy.allowed) return false
      const contentAllowed = this.contentAuthorized(i, policyOpts)
      if (metadataQuery && (!this.config.content.metadata || !contentAllowed)) return false
      if (!contentAllowed) { e.sources.delete("content"); e.lines = undefined; e.count = 0 }
      return e.sources.size > 0
    })
    res.total = Math.max(res.total, top.length)
    const sort = q.filters.sort
    if (sort) {
      // The lists may hold every match: pick the first `limit` rather than sort them all.
      const first = new TopK<(typeof top)[number]>(limit, () => 0, (a, b) => this.compareIds(b.id, a.id, sort))
      for (const t of limit > 0 ? top : []) first.add(t)
      top = first.values()
    } else {
      top.sort((a, b) => b.score - a.score)
      top.length = Math.min(top.length, limit)
    }
    // Typo expansions are highlighted as whole words.
    const pattern = keepLines ? null : termsPattern(q.words, [...q.phrases, ...this.lastExpansions], q.typing)
    res.hits = top.map(({ id, e, score }, n) => {
      const h = this.hit(id, score, [...e.sources])
      const positions = namePositions?.(id) ?? e.positions
      if (positions) h.namePositions = positions
      h.matchCount = e.count
      if (e.lines) h.lines = e.lines
      else if (pattern && e.sources.has("content") && n < SNIPPET_HITS) {
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
      return keywordLines(text, pattern, maxLines, true, 10_000, this.texts.folded(id, text))
    } catch {
      return { lines: [], count: 0 }
    }
  }

  /* ----------------------------------------------------------- preview -- */

  preview(id: number, rawQuery: string, mode: Mode, focusLineHint?: number, window = 400): Preview {
    // The text cache must not outlive an index update made by another process.
    this.refresh()
    const i = this.catalog.indexOf(id)
    const row = this.db.query("SELECT path, kind, is_dir, size, mtime, source_path, content_state, note FROM files WHERE id = ?").get(id) as {
      path: string
      kind: Kind
      is_dir: number
      size: number
      mtime: number
      source_path: string
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
    if (!row) return { ...base, contentAllowed: false, message: "file is no longer in the index" }
    const policy = pathPolicy(row.path, crawlOptionsFor(this.config))
    if (!policy.allowed) return { ...base, contentAllowed: false, message: policy.reason }
    if (row.is_dir) return this.folderPreview(base)
    if (this.config.content.enabled && policy.reason === "speech transcription is disabled in settings") return { ...base, contentAllowed: true, message: policy.reason }
    if (!this.config.content.enabled || !policy.content || (row.source_path && row.source_path !== policy.real)) return { ...base, contentAllowed: false, message: policy.reason ?? "file contents are disabled in settings" }
    // Found to hold only keys when it was read: names-only like a key file's path, so no app
    // renders it from disk either.
    if (row.note === SECRET_NOTE) return { ...base, contentAllowed: false, message: "key or password file: indexed by name only" }
    let text: string | null = null
    const stored = this.storedText(id)
    if (stored !== null) {
      text = stored
      base.source = "index"
    } else if (row.size > 0 && row.size < 2 * 1024 * 1024 && row.content_state !== 1) {
      try {
        const buf = boundedFile(policy.real!, 2 * 1024 * 1024)
        if (!looksBinary(buf)) {
          // Keys stay out of previews, as out of the index, even in a file changed since.
          text = redactPrivateKeys(decodeText(buf))
          if (onlyKeys(text)) text = null
          else base.source = "disk"
        }
      } catch {
        // unreadable
      }
    }
    if (text === null) return { ...base, message: noTextReason(row, "no text preview for this kind of file") }
    const all = splitLines(text)
    base.totalLines = all.length
    // Page starts for paged documents (PDF pages, slides, sheets).
    base.pageStarts = pageStartsOf(text)
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
    const folded = parseQuery(rawQuery).fold && base.matchLines.length > 0
    const visible = new Set<number>()
    if (folded) for (const match of base.matchLines) for (let n = Math.max(1, match - 2); n <= Math.min(all.length, match + 2); n++) visible.add(n)
    for (const n of folded ? [...visible].sort((a, b) => a - b).slice(0, window) : Array.from({ length: to - from + 1 }, (_, i) => from + i)) {
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
    const q = parseQuery(rawQuery, Date.now(), mode)
    if ((q.forcedMode ?? mode) === "find") return q.text ? { re: this.buildRegex(q, q.regex).re, folded: false } : null
    const p = termsPattern(q.words, q.phrases, q.typing)
    return p ? { re: new RegExp(p, "giu"), folded: true } : null
  }

  private folderPreview(base: Preview): Preview {
    let names: string[] = []
    try {
      names = listFolder(base.path, this.config)
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
      this.saveTimer = this.clock.setTimeout(() => {
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

/** A word without a plural or verb ending, to match its other forms as a prefix ("invoices" → "invoice*"). */
function stemOf(term: string): string {
  if (/\p{N}/u.test(term)) return term
  for (const [end, keep] of [["ies", 3], ["ing", 4], ["ed", 4], ["es", 4], ["s", 4]] as const) {
    if (term.endsWith(end) && !term.endsWith("ss") && term.length - end.length >= keep) return term.slice(0, -end.length)
  }
  return term
}

/**
 * The lines of a passage to show for a meaning match: those with the query's words, or else its
 * first lines. Line and page numbers count from the start of the file's text.
 */
function passageLines(text: string, start: number, end: number, pattern: string | null): LineMatch[] {
  let line = 1
  let page = 1
  for (let k = 0; k < start && k < text.length; k++) {
    const c = text.charCodeAt(k)
    if (c === 10) line++
    else if (c === 12) { line++; page++ }
  }
  const slice = text.slice(start, end)
  if (pattern) {
    try {
      const found = keywordLines(slice, pattern, 3)
      if (found.lines.length) return found.lines.map((l) => ({ ...l, line: l.line + line - 1, page: l.page + page - 1, offset: undefined }))
    } catch {}
  }
  const out: LineMatch[] = []
  let from = 0
  for (let k = 0; k <= slice.length && out.length < 2; k++) {
    const c = k < slice.length ? slice.charCodeAt(k) : 10
    if (c !== 10 && c !== 12) continue
    const t = slice.slice(from, k).trim()
    if (t) out.push({ line, page, ...clipLine(t, []) })
    line++
    if (c === 12) page++
    from = k + 1
  }
  return out
}

/** The query text for name matching, with negations as fzf `!` terms. */
function fuzzyQueryText(q: ParsedQuery): string {
  const parts = [...q.words, ...q.phrases.map((p) => `'${p.replace(/\s+/g, " ")}`)]
  for (const n of q.negated) parts.push(`!${n}`)
  return parts.join(" ")
}


function usesMetadata(filters: Filters): boolean { return !!filters.tags?.length || !!filters.not?.some(usesMetadata) }
