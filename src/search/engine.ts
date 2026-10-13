import { boundedFile } from "../util/files.ts"
import type { Database } from "bun:sqlite"
import { readdirSync } from "node:fs"
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
import { clipLine, diacriticPattern, findLines, keywordLines, type LineMatch, splitLines, termsPattern } from "./snippet.ts"
import { reqToFts, Vocab } from "./vocab.ts"
import { booleanQuery, type QueryExpression } from "./boolean.ts"
import { TopK } from "../util/top-k.ts"
import { retryClock, type RetryClock } from "../util/clock.ts"
import { availableParallelism } from "node:os"
import { Embedder, embedToolPath } from "../semantic/helper.ts"
import { GRANITE, installedModel, POTION, type Tier } from "../semantic/model.ts"
import { PotionEmbedder, PotionModel } from "../semantic/potion.ts"
import { documentPrompt, titleOf } from "../semantic/chunk.ts"
import { bestByFile, CODE_WORD_WEIGHT, isLookup, kindHints, meaning, outdatedFiles, QueryEmbedder, queryTerms, rank, SemanticVectors, VectorIndex, WORD_WEIGHT } from "../semantic/search.ts"
import { semanticDbPath } from "../semantic/store.ts"
import { mainGeneration, textSig } from "../semantic/indexer.ts"

type Source = "name" | "content"

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
}

const FETCH_BATCH = 64
/** How many full-text candidates are ranked by their text (the rest by name, folders and date). */
const RANK_POOL = 128

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
  }

  delete(id: number) {
    const old = this.map.get(id)
    if (old !== undefined) { this.chars -= old.length; this.map.delete(id) }
  }

  get full(): boolean {
    return this.chars >= this.maxChars * 0.9
  }
}

/** A query word or phrase: its FTS5 expression, and the terms that count as it when ranking. */
/**
 * `check`: the expression also matches files without the word (see `ftsPrefixExpr`), which must
 * have a match for this in their path or text.
 */
type TermGroup = { expr: string; terms: string[]; prefix: boolean; check?: RegExp }

type Ranked = { id: number; positions?: number[]; lines?: LineMatch[]; count?: number; raw?: number }

/** Files reranked with Granite at search time, at most, while Granite hasn't read every file. */
const RERANK = 12
/** Passages Granite's index needs before its scale is worth putting reranked passages on. */
const RERANK_MIN_PASSAGES = 200

function concatScores(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

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
    const returned = res.hits.length
    res.hits = res.hits.filter((hit) => {
      const policy = policyOpts(hit.path)
      if (!policy.allowed) return false
      const i = this.catalog.indexOf(hit.id)
      const contentAllowed = i !== undefined && this.contentAuthorized(i, policyOpts)
      if (usesMetadata(parseQuery(res.query).filters) && (!this.config.content.metadata || !contentAllowed)) return false
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
    const parts: SearchResponse[] = []
    for (const part of expr.parts) parts.push(await this.searchExpression(part, query, mode, { ...opts, limit: 5000, budgetMs: Math.max(1, deadline - performance.now()) }, started))
    if (this.revision !== revision || this.config !== config) return this.done({ query, mode, resolved: mode, strategy: "grouped search interrupted", hits: [], total: 0, elapsedMs: 0, partial: true }, started)
    const merged = new Map<number, SearchHit>()
    for (const [n, part] of parts.entries()) for (const h of part.hits) {
      const old = merged.get(h.id)
      if (!old && (expr.op === "or" || n === 0)) merged.set(h.id, structuredClone(h))
      else if (old) { old.score += h.score; old.sources = [...new Set([...old.sources, ...h.sources])]; old.lines.push(...h.lines.filter((l) => !old.lines.some((o) => o.line === l.line))) }
    }
    if (expr.op === "and") for (const id of merged.keys()) if (parts.some((p) => !p.hits.some((h) => h.id === id))) merged.delete(id)
    const sort = parseQuery(query).filters.sort
    const hits = [...merged.values()].sort((a, b) => sort ? this.compareIds(a.id, b.id, sort) : b.score - a.score)
    return this.done({ query, mode, resolved: mode, strategy: "grouped search", total: hits.length, hits: hits.slice(0, opts.limit ?? 100), elapsedMs: 0, partial: parts.some((p) => p.partial || p.total > p.hits.length), error: parts.find((p) => p.error)?.error }, started)
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
  }

  /* ---------------------------------------------------------- semantic -- */

  /** The semantic indexes (Potion's and Granite's), loaded on the first semantic search. */
  private vectors: Partial<Record<Tier, SemanticVectors>> = {}
  private queryEmbedders: Partial<Record<Tier, QueryEmbedder>> = {}
  /** Turns a query into one model's vector (tests pass their own). Null: no model is there. */
  embedQuery: ((text: string, tier: Tier) => Promise<Float32Array>) | null | undefined

  /** The query's vector for a model, or null when that model (or Granite's helper) is missing. */
  private queryVectorFn(tier: Tier): ((text: string) => Promise<Float32Array>) | null {
    if (this.embedQuery !== undefined) return this.embedQuery && ((text) => this.embedQuery!(text, tier))
    let embedder = this.queryEmbedders[tier]
    if (!embedder) {
      if (tier === "fast") {
        const files = installedModel(POTION)
        if (!files) return null
        embedder = new QueryEmbedder(() => new PotionEmbedder(PotionModel.load(files[0]!, files[1]!)))
      } else {
        const tool = embedToolPath()
        const files = installedModel(GRANITE)
        if (!tool || !files) return null
        embedder = new QueryEmbedder(() => new Embedder({ tool, model: files[0]!, pooling: "cls", threads: Math.min(4, availableParallelism()), batchTokens: 2048, maxSeqs: 16 }))
      }
      this.queryEmbedders[tier] = embedder
    }
    return (text) => embedder.embed(text)
  }

  /** Passages Granite's index needs before its scale is worth putting reranked passages on (tests lower it). */
  rerankMinPassages = RERANK_MIN_PASSAGES
  /** Embeds passages with Granite at search time (tests pass their own). */
  embedPassages: ((texts: string[]) => Promise<Float32Array[]>) | undefined

  /**
   * The best passage of each of the RERANK files Potion ranks highest that Granite hasn't read
   * yet, embedded with Granite now (and kept for later searches), as a small index of its own.
   */
  private async rerankWithGranite(fast: { index: VectorIndex; z: Float64Array; tier: Tier }, full: VectorIndex, outdated: Set<number>, authorized: (file: number) => boolean): Promise<VectorIndex | null> {
    const upgraded = new Set(full.file.filter((f) => !outdated.has(Math.abs(f))))
    const pool = [...bestByFile([fast], (f) => !upgraded.has(f) && authorized(f))].sort((a, b) => b[1].z - a[1].z).slice(0, RERANK)
    const picked: { file: number; start: number; end: number; text: string }[] = []
    for (const [file, b] of pool) {
      const stored = this.storedText(file)
      const i = this.catalog.indexOf(file)
      if (stored === null || i === undefined) continue
      const start = fast.index.start[b.row]!
      const end = fast.index.end[b.row]!
      const name = this.catalog.paths[i]!.slice(this.catalog.paths[i]!.lastIndexOf("/") + 1)
      picked.push({ file, start, end, text: documentPrompt(titleOf(name), stored.slice(start, end).replace(/[ \t ]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n")) })
    }
    if (!picked.length) return null
    const embed = this.embedPassages ?? this.granitePassagesFn()
    if (!embed) return null
    const vectors = await embed(picked.map((p) => p.text))
    return VectorIndex.of(picked.map((p, k) => ({ file: p.file, start: p.start, end: p.end, vector: vectors[k]! })))
  }

  /** What a file's passages would be read from now (see `textSig`), or null if it has no text. */
  private semanticSig(file: number): string | null {
    const r = this.db.query("SELECT size, mtime, content_len AS len FROM files WHERE id = ?").get(file) as { size: number; mtime: number; len: number } | null
    return r ? textSig(r.size, r.mtime, r.len) : null
  }

  private granitePassagesFn(): ((texts: string[]) => Promise<Float32Array[]>) | null {
    if (this.embedQuery !== undefined) return this.embedQuery && ((texts) => Promise.all(texts.map((t) => this.embedQuery!(t, "full"))))
    if (!this.queryVectorFn("full")) return null
    const embedder = this.queryEmbedders.full!
    return (texts) => embedder.embedPassages(texts)
  }

  /** Stop the query models and let go of the vectors (the worker is shutting down, or idle). */
  closeSemantic() {
    for (const e of Object.values(this.queryEmbedders)) e.close()
    this.queryEmbedders = {}
    for (const v of Object.values(this.vectors)) v.close()
    this.vectors = {}
  }

  /**
   * Semantic search, ranked as DigUp ranks (see src/semantic/search.ts): files whose best passage
   * stands out for the query, and files holding at least half of its words. Without the model, or
   * before files have vectors, only the words count, and a notice says why.
   */
  private async runSemantic(q: ParsedQuery, limit: number, res: SearchResponse, opts: SearchOptions) {
    const notices: string[] = []
    // While typing, wait a moment: the next key press would make this query's vector wasted work.
    if (q.typing && opts.cancelled) {
      await Bun.sleep(150)
      if (opts.cancelled()) { res.partial = true; res.strategy = "semantic"; return }
    }
    const text = [...q.words, ...q.phrases].join(" ")
    const cat = this.catalog
    const check = policyFor(crawlOptionsFor(this.config))
    const usable = (id: number): number | undefined => {
      const i = cat.indexOf(id)
      return i !== undefined && cat.passes(i, q.filters) && !semanticExcluded(cat.paths[i]!) ? i : undefined
    }

    // Meaning: every passage of each model's index on that model's scale for this query, and
    // each file's best, from Granite's index once Granite has read the file, Potion's until then.
    // While Granite is part way, the files Potion ranks highest that Granite hasn't read yet
    // have their best passage embedded with Granite now (see `rerankWithGranite`).
    let best = new Map<number, { z: number; row: number; index: VectorIndex; tier: Tier }>()
    const indexes: Partial<Record<Tier, VectorIndex>> = {}
    if (!this.config.semantic.enabled) notices.push("Semantic search is off: turn it on with `zsearch semantic install` (or in the app's settings). Showing word matches")
    else if (!this.config.content.enabled) notices.push("Semantic search needs file contents, which are off")
    else {
      const generation = mainGeneration(this.db)
      const scored: Partial<Record<Tier, { index: VectorIndex; scores: Float32Array; vector: Float32Array }>> = {}
      const errors: string[] = []
      let models = 0
      for (const tier of ["full", "fast"] as const) {
        const embed = this.queryVectorFn(tier)
        if (!embed) continue
        models++
        const vectors = (this.vectors[tier] ??= new SemanticVectors(semanticDbPath(this.db.filename || ":memory:", tier)))
        const index = vectors.get(generation)
        if (!index?.size || !text.trim()) continue
        try {
          const vector = await embed(text)
          if (opts.cancelled?.()) { res.partial = true; res.strategy = "semantic"; return }
          indexes[tier] = index
          scored[tier] = { index, scores: index.score(vector), vector }
        } catch (err) {
          errors.push((err as Error).message)
        }
      }
      const authorized = (file: number) => {
        const i = usable(file)
        return i !== undefined && this.contentAuthorized(i, check)
      }
      const parts: { index: VectorIndex; z: Float64Array; tier: Tier; outdated?: Set<number> }[] = []
      if (scored.fast) parts.push({ ...scored.fast, z: meaning(scored.fast.scores, scored.fast.index.modality, scored.fast.index.setsScale), tier: "fast" })
      if (scored.full) {
        const { index, scores, vector } = scored.full
        // Files edited since Granite read them, that Potion has read again: Potion's passages count.
        const outdated = scored.fast ? outdatedFiles(index, scored.fast.index, (file) => this.semanticSig(file)) : new Set<number>()
        let extra: VectorIndex | null = null
        if (scored.fast && index.size >= this.rerankMinPassages) {
          try {
            extra = await this.rerankWithGranite(parts[0]!, index, outdated, authorized)
          } catch (err) {
            errors.push((err as Error).message)
          }
          if (opts.cancelled?.()) { res.partial = true; res.strategy = "semantic"; return }
        }
        // Reranked passages are put on the scale of Granite's index, without moving it.
        const all = extra ? concatScores(scores, extra.score(vector)) : scores
        const modality = extra ? new Uint8Array(all.length) : index.modality
        const setsScale = extra ? Uint8Array.from({ length: all.length }, (_, i) => (i < scores.length ? index.setsScale[i]! : 0)) : index.setsScale
        const z = meaning(all, modality, setsScale)
        parts.push({ index, z: z.subarray(0, scores.length), tier: "full", outdated })
        if (extra) parts.push({ index: extra, z: z.subarray(scores.length), tier: "full" })
      }
      if (!models) notices.push("Semantic search needs its models: run `zsearch semantic install`. Showing word matches")
      else if (!indexes.fast && !indexes.full && errors.length) notices.push(`Semantic search failed (${errors[0]}). Showing word matches`)
      else if (!indexes.fast && !indexes.full && text.trim()) notices.push("No files have been read for semantic search yet: they are with the next index update")
      best = bestByFile(parts, authorized)
    }

    // Words: the share of the query's words each file holds, in its name or folders, or its text.
    const terms = queryTerms(text)
    const coverage = new Map<number, number>()
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
    terms.forEach((term, t) => {
      // Endings count as the same word ("invoices", "invoice"), as DigUp's stemmed index has it.
      const stem = stemOf(term)
      const prefix = stem !== term || (q.typing && t === terms.length - 1)
      const has = new Set<number>()
      for (const id of matching("{name dirs}", stem, prefix)) if (usable(id) !== undefined) { has.add(id); nameMatch.add(id) }
      if (this.config.content.enabled) for (const id of matching("body", stem, prefix)) {
        if (has.has(id)) continue
        const i = usable(id)
        if (i !== undefined && canRead(id, i)) { has.add(id); bodyMatch.add(id) }
      }
      for (const id of has) coverage.set(id, (coverage.get(id) ?? 0) + 1 / terms.length)
    })
    // Words after `-` or `!` rule a file out.
    for (const n of q.negated.flatMap((w) => foldTerm(w).match(/[\p{L}\p{N}]+/gu) ?? [])) {
      for (const id of matching("{name dirs}", n, false)) { best.delete(id); coverage.delete(id) }
      for (const id of matching("body", n, false)) { best.delete(id); coverage.delete(id) }
    }

    const ranked = rank({
      best,
      coverage,
      lookup: isLookup(terms),
      wordWeight: WORD_WEIGHT,
      hinted: kindHints(text),
      kindOf: (file) => { const i = cat.indexOf(file); return i === undefined ? undefined : cat.kinds[i] },
    })
    // Code's words are everywhere in code: they count for half (DigUp's code index does the same).
    for (const r of ranked) {
      const i = cat.indexOf(r.file)
      if (i !== undefined && (cat.kinds[i] === "code" || cat.kinds[i] === "data")) r.score -= (WORD_WEIGHT - CODE_WORD_WEIGHT) * (isLookup(terms) ? 2 : 1) * (coverage.get(r.file) ?? 0) ** 1.5
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
      if (n >= 60) return h
      // Show the passage that matched by meaning; or, matched by words, the lines with them.
      const index = r.row !== null ? best.get(r.file)!.index : undefined
      // Potion's passage only when the words aren't in the text: its best one may not be about them.
      const strong = best.get(r.file)?.tier === "fast" ? false : r.z! >= 2
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
      .sort((a, b) => q.filters.sort ? this.compareIds(a.id, b.id, q.filters.sort) : b.score - a.score)
    const policyOpts = policyFor(crawlOptionsFor(this.config))
    const top = ranked.filter(({ id, e }) => {
      const i = this.catalog.indexOf(id)
      if (i === undefined) return false
      const policy = policyOpts(this.catalog.paths[i]!)
      if (!policy.allowed) return false
      if (usesMetadata(q.filters) && (!this.config.content.metadata || !this.contentAuthorized(i, policyOpts))) return false
      if (!this.contentAuthorized(i, policyOpts)) { e.sources.delete("content"); e.lines = undefined; e.count = 0 }
      return e.sources.size > 0
    })
    res.total = Math.max(res.total, top.length)
    top.length = Math.min(top.length, limit)
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
    if (!row) return { ...base, message: "file is no longer in the index" }
    const policy = pathPolicy(row.path, crawlOptionsFor(this.config))
    if (!policy.allowed) return { ...base, contentAllowed: false, message: policy.reason }
    if (row.is_dir) return this.folderPreview(base)
    if (!this.config.content.enabled || !policy.content || (row.source_path && row.source_path !== policy.real)) return { ...base, contentAllowed: false, message: policy.reason ?? "file contents are disabled in settings" }
    let text: string | null = null
    const stored = this.storedText(id)
    if (stored !== null) {
      text = stored
      base.source = "index"
    } else if (row.size > 0 && row.size < 2 * 1024 * 1024 && row.content_state !== 1 && row.note !== SECRET_NOTE) {
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
                  : row.note === SECRET_NOTE
                    ? "key or password file: indexed by name only"
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
    const q = parseQuery(rawQuery)
    if ((q.forcedMode ?? mode) === "find") return q.text ? { re: this.buildRegex(q, q.regex).re, folded: false } : null
    const p = termsPattern(q.words, q.phrases, q.typing)
    return p ? { re: new RegExp(p, "giu"), folded: true } : null
  }

  private folderPreview(base: Preview): Preview {
    let names: string[] = []
    try {
      names = readdirSync(base.path, { withFileTypes: true })
        .filter((d) => pathPolicy(`${base.path}/${d.name}`, crawlOptionsFor(this.config)).allowed)
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
