/**
 * Semantic retrieval over Potion and complete Granite indexes. Passage similarities are
 * normalized per query and model; each file takes its best passage. Long documents and shared
 * boilerplate are discounted. Saved names receive a finite boost, and literal code/ID queries
 * retain their exact-word preference. Complete Granite and Potion contribute complementary
 * evidence; partial Granite is excluded by the engine's readiness check.
 */
import type { Database } from "bun:sqlite"
import { statSync } from "node:fs"
import type { Kind } from "../kinds.ts"
import { foldTerm } from "../util/text.ts"
import { queryPrompt } from "./chunk.ts"
import type { TextEmbedder } from "./helper.ts"
import { SCALE_PASSAGES } from "./indexer.ts"
import { getMeta, openSemanticDb, vectorValues } from "./store.ts"

/** A file's best passage must stand out by this many deviations to count as a meaning match. */
export const Z_GATE = 2.0
/** How much Potion's meaning counts, against words: enough to order files the words tie. */
const POTION_WEIGHT = 1e-3

/** How results are put together; benchmarks (`scripts/semantic-bench.ts`) try others. */
export interface Ranking {
  /**
   * Comparison pipelines can anchor Potion ("auto"), anchor every stage ("always"),
   * or combine finite evidence ("never", the production default).
   */
  anchor: "auto" | "always" | "never"
  /** "score": by the scores above; "rrf": reciprocal rank fusion of the word and meaning orders. */
  fusion: "score" | "rrf"
  /** What the query's words in a file's name or folders add (all of them). */
  name: number
  /** A file's best passage stands out by this much less per e-fold of passages it has: the best of many stands out by chance. */
  length: number
  /** ...and per e-fold of passages sharing its text: a header many files repeat says little about any one of them. */
  shared: number
  /** Optional finite bonus for holding every word (zero in semantic search). */
  everyWord: number
  /** How much words and meaning count (meaning-only search: words 0). */
  words: number
  meaning: number
  /** What keyword search's own order of the word matches (BM25) adds, at most. */
  strength: number
  /** Semantic-stage coverage weight; name evidence is controlled independently. */
  coverage?: number
  fastCoverage?: number
  /** Potion has a different score distribution and length penalty. */
  fastLength?: number
  /** Share of Potion's score retained when Granite is complete. */
  fastBlend?: number
  namePower?: number
  /** Weights when there are no model vectors. */
  keywordName?: number
  keywordCoverage?: number
  keywordEveryWord?: number
}

export const RANKING: Ranking = {
  anchor: "never", fusion: "score", name: 2, namePower: 2, length: 0.7, shared: 0.5,
  everyWord: 0, words: 1, meaning: 1, strength: 0, coverage: 0.5, fastCoverage: 0,
  fastLength: 0.15, fastBlend: 0.5,
  keywordName: 1, keywordCoverage: 0, keywordEveryWord: 0.5,
}
/** DigUp's, as zsearch ranked before. */
export const DIGUP_RANKING: Ranking = { anchor: "never", fusion: "score", name: 0, length: 0, shared: 0, everyWord: 0, words: 1, meaning: 1, strength: 0 }
/** How much the query's words count against meaning (DigUp's `wordWeight`; code's are worth half). */
export const WORD_WEIGHT = 2.0
export const CODE_WORD_WEIGHT = 1.0

export type Modality = "text" | "image"

/**
 * This query's meaning scores: each passage's cosine similarity minus the average of its modality
 * (text and image vectors sit at different levels for the same query), in standard deviations of
 * all of them together. Only passages in `setsScale` set the averages and the deviation (the later
 * passages of long files are scored on that scale but don't move it). As DigUp's `meaning`.
 */
export function meaning(scores: Float32Array | number[], modality: ArrayLike<number>, setsScale: ArrayLike<number> | null = null): Float64Array {
  const n = scores.length
  // Modality averages; a modality with fewer than 20 passages takes the average of all.
  const sum = [0, 0]
  const count = [0, 0]
  for (let i = 0; i < n; i++) {
    if (setsScale && !setsScale[i]) continue
    sum[modality[i]!]! += scores[i]!
    count[modality[i]!]!++
  }
  const all = (sum[0]! + sum[1]!) / Math.max(count[0]! + count[1]!, 1)
  const means = [0, 1].map((m) => (count[m]! >= 20 ? sum[m]! / count[m]! : all))
  const centered = new Float64Array(n)
  let c = 0
  let s = 0
  for (let i = 0; i < n; i++) {
    centered[i] = scores[i]! - means[modality[i]!]!
    if (setsScale && !setsScale[i]) continue
    c++
    s += centered[i]!
  }
  const mean = s / Math.max(c, 1)
  let squares = 0
  for (let i = 0; i < n; i++) {
    if (setsScale && !setsScale[i]) continue
    squares += (centered[i]! - mean) ** 2
  }
  const deviation = Math.max(Math.sqrt(squares / Math.max(c, 1)), 0.02)
  for (let i = 0; i < n; i++) centered[i] = (centered[i]! - mean) / deviation
  return centered
}

/** Words that say what to look for rather than what is in it (DigUp's English stopwords and kind words). */
const STOPWORDS = new Set([
  "how", "does", "did", "do", "can", "could", "would", "should",
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "with", "and", "or", "my", "me", "that", "this",
  "these", "those", "from", "about", "where", "what", "which", "who", "when", "is", "was", "are", "were", "be",
  "it", "its", "some", "any", "find", "show", "file", "files", "photo", "photos", "picture", "image", "images",
  "screenshot", "screenshots", "video", "videos", "pdf", "document", "documents", "recording",
])

/** The query's content words, folded as the keyword index keeps its text, without stopwords. */
export function queryTerms(text: string): string[] {
  const seen = new Set<string>()
  return (foldTerm(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => [...w].length >= 2 && !STOPWORDS.has(w) && !seen.has(w) && (seen.add(w), true))
}

/**
 * Codes and IDs ("K7Q2LM", "TRX50") and long numbers mean nothing to an embedding but everything
 * to keyword search: a query made only of them weighs words double and meaning half.
 */
export function isLookup(terms: string[]): boolean {
  return terms.length > 0 && terms.every((t) => /\p{N}/u.test(t) && (/\p{L}/u.test(t) || t.length >= 4))
}

/** Kind words, as DigUp's `kindWords`, mapped to zsearch's kinds (screenshots are images here). */
const KIND_WORDS: Record<string, Kind[]> = {
  screenshot: ["image"], screenshots: ["image"], photo: ["image"], photos: ["image"], picture: ["image"],
  pictures: ["image"], image: ["image"], images: ["image"], pdf: ["pdf"], pdfs: ["pdf"], paper: ["pdf"],
  papers: ["pdf"], document: ["doc"], documents: ["doc"], note: ["doc", "text", "markdown"], notes: ["doc", "text", "markdown"],
  video: ["video"], videos: ["video"], clip: ["video"], movie: ["video"], audio: ["audio"], song: ["audio"],
  podcast: ["audio"], voice: ["audio"], sound: ["audio"],
  // zsearch's own kinds DigUp doesn't have.
  spreadsheet: ["sheet"], spreadsheets: ["sheet"], slides: ["slides"], presentation: ["slides"], deck: ["slides"],
  email: ["email"], emails: ["email"], mail: ["email"], book: ["ebook"], ebook: ["ebook"],
}

/** The kinds a query asks for: a soft boost, not a filter. */
export function kindHints(text: string): Set<Kind> {
  const out = new Set<Kind>()
  for (const w of foldTerm(text).match(/[\p{L}\p{N}]+/gu) ?? []) for (const k of KIND_WORDS[w] ?? []) out.add(k)
  return out
}

/** How many hits (best first) score at least `ratio` of the top one: the rest are weaker matches. */
export function strongCount(scores: number[], ratio = 0.5): number {
  const top = scores[0]
  if (top === undefined || top <= 0) return scores.length
  let n = 0
  while (n < scores.length && scores[n]! >= top * ratio) n++
  return n
}

export interface Ranked {
  file: number
  score: number
  /** The file's best passage (a row of the vector index), and how far it stood out. */
  row: number | null
  z: number | null
}

/**
 * Score the candidates: files whose best passage stands out (`best`), and files holding at least
 * half of the query's words (`coverage`, 0..1). Finite name evidence helps find saved files
 * without letting incidental body words overwhelm semantic answers. Keyword-only searches
 * use separate weights; code and number lookups retain their exact-word preference.
 * Alternative benchmark pipelines can still request strict keyword anchoring or rank fusion.
 */
export function rank(opts: { best: Map<number, { z: number; row: number; anchored?: boolean; gateZ?: number }>; named?: Map<number, number>; strength?: Map<number, number>; coverage: Map<number, number>; lookup: boolean; wordWeight: number; hinted: Set<Kind>; kindOf: (file: number) => Kind | undefined; zGate?: number; ranking?: Ranking }): Ranked[] {
  const R = opts.ranking ?? RANKING
  const zGate = opts.zGate ?? Z_GATE
  const hasMeaning = opts.best.size > 0
  const fast = hasMeaning && [...opts.best.values()].every(b => b.anchored)
  const coverageWeight = opts.lookup ? 1 : hasMeaning ? (fast ? (R.fastCoverage ?? R.coverage ?? 1) : (R.coverage ?? 1)) : (R.keywordCoverage ?? 1)
  const nameWeight = hasMeaning ? R.name : (R.keywordName ?? R.name)
  const namePower = hasMeaning ? (R.namePower ?? 1) : 1
  const everyWord = hasMeaning ? R.everyWord : (R.keywordEveryWord ?? R.everyWord)
  const [meaningWeight, baseWordsWeight] = opts.lookup ? [0.5 * R.meaning, opts.wordWeight * 2 * R.words] : [R.meaning, opts.wordWeight * R.words]
  const wordsWeight = baseWordsWeight * coverageWeight
  const candidates = new Set<number>()
  for (const [file, b] of opts.best) if ((b.gateZ ?? b.z) >= zGate) candidates.add(file)
  if (R.words > 0) for (const [file, share] of opts.coverage) if (share >= 0.5) candidates.add(file)
  const out: Ranked[] = []
  for (const file of candidates) {
    const b = opts.best.get(file)
    const words = opts.coverage.get(file) ?? 0
    const z = b?.z ?? 0
    let score: number
    const name = (nameWeight * (opts.named?.get(file) ?? 0) ** namePower + R.strength * (opts.strength?.get(file) ?? 0)) * R.words
    const anchored = R.anchor === "always" || (R.anchor === "auto" && !!b?.anchored)
    if (anchored) {
      // As without a model, meaning only ordering the files the words tie (bounded, so that it
      // can't reach the next word match), and its own matches after every word match.
      score = (words >= 0.5 ? wordsWeight * words ** 1.5 + name : 0) + POTION_WEIGHT * Math.tanh(z / 4)
      if (words < 0.5) { out.push({ file, score, row: b?.row ?? null, z }); continue }
    } else {
      // Finite evidence: no word match automatically outranks a better semantic answer.
      score = meaningWeight * Math.max(z, 0) + wordsWeight * words ** 1.5 + name + (words >= 1 - 1e-9 ? everyWord * R.words : 0)
    }
    const kind = opts.kindOf(file)
    if (kind && opts.hinted.has(kind)) score += 1
    out.push({ file, score, row: b?.row ?? null, z: b?.z ?? null })
  }
  if (R.fusion === "rrf") {
    // Each file's rank by words (and name) and by meaning, fused: 1/(60 + rank) from each list it is in.
    const byWords = out.filter((r) => (opts.coverage.get(r.file) ?? 0) >= 0.5).sort((a, b) => wordsOf(b.file) - wordsOf(a.file) || a.file - b.file)
    const byMeaning = out.filter((r) => r.z !== null).sort((a, b) => b.z! - a.z! || a.file - b.file)
    const fused = new Map<number, number>()
    byWords.forEach((r, i) => fused.set(r.file, (fused.get(r.file) ?? 0) + 1 / (60 + i)))
    byMeaning.forEach((r, i) => fused.set(r.file, (fused.get(r.file) ?? 0) + 1 / (60 + i)))
    for (const r of out) r.score = fused.get(r.file) ?? 0
  }
  return out.sort((a, b) => b.score - a.score || a.file - b.file)

  function wordsOf(file: number): number {
    return (opts.coverage.get(file) ?? 0) ** 1.5 * 2 + R.name * (opts.named?.get(file) ?? 0) + R.strength * (opts.strength?.get(file) ?? 0)
  }
}

/* ------------------------------------------------------- the vectors -- */

/**
 * The semantic index in memory: each distinct vector once (16-bit floats), and each passage
 * with the vector it uses. Cosine similarity is scored per distinct vector, then read per passage.
 */
export class VectorIndex {
  dim = 0
  complete = true
  completeSeq: string | null = null
  /** Passages: file id (negative for an image's own vector), number, place in the text, and vector. */
  file = new Int32Array(0)
  start = new Int32Array(0)
  end = new Int32Array(0)
  vector = new Int32Array(0)
  modality = new Uint8Array(0)
  setsScale = new Uint8Array(0)
  /** What each file's passages were read from (its size, date and text length), by file id. */
  sigs = new Map<number, string>()
  private values = new Float16Array(0)
  private distinct = 0

  get size(): number {
    return this.file.length
  }

  /** Granite is usable only for a completed, current snapshot covering Potion's files. */
  isCompleteFor(sequence: string, fast?: VectorIndex): boolean {
    if (!this.complete || this.completeSeq !== sequence) return false
    if (!fast) return true
    if (!fast.complete || fast.completeSeq !== sequence) return false
    for (const [file, sig] of fast.sigs) if (this.sigs.get(file) !== sig) return false
    return true
  }

  private counts: Map<number, number> | null = null
  /** How many passages each file has here. */
  passages(file: number): number {
    if (!this.counts) {
      this.counts = new Map()
      for (const f of this.file) this.counts.set(f, (this.counts.get(f) ?? 0) + 1)
    }
    return this.counts.get(file) ?? 0
  }

  private uses: Int32Array | null = null
  /** How many passages share this passage's text (its vector): boilerplate many files hold. */
  sharing(row: number): number {
    if (!this.uses) {
      this.uses = new Int32Array(this.distinct)
      for (const k of this.vector) this.uses[k]!++
    }
    return this.uses[this.vector[row]!] ?? 1
  }

  /** An index of these passages, one vector each (tests and small evaluations). */
  static of(rows: { file: number; start: number; end: number; vector: Float32Array }[]): VectorIndex {
    const v = new VectorIndex()
    const n = rows.length
    v.dim = n ? rows[0]!.vector.length : 0
    v.file = Int32Array.from(rows, (r) => r.file)
    v.start = Int32Array.from(rows, (r) => r.start)
    v.end = Int32Array.from(rows, (r) => r.end)
    v.vector = Int32Array.from(rows, (_, i) => i)
    v.modality = new Uint8Array(n)
    v.setsScale = new Uint8Array(n)
    v.values = new Float16Array(n * v.dim)
    rows.forEach((r, i) => v.values.set(r.vector, i * v.dim))
    v.distinct = n
    return v
  }

  static load(db: Database): VectorIndex {
    const v = new VectorIndex()
    const index = new Map<string, number>()
    const vecs = db.query("SELECT hash, vec FROM vectors").values() as [Uint8Array, Uint8Array][]
    v.dim = vecs.length ? vecs[0]![1].length / 2 : 0
    v.values = new Float16Array(vecs.length * v.dim)
    let k = 0
    for (const [hash, vec] of vecs) {
      const values = vectorValues(vec, v.dim)
      if (!values) continue
      v.values.set(values, k * v.dim)
      index.set(Buffer.from(hash).toString("hex"), k++)
    }
    v.distinct = k
    const rows = db.query("SELECT file, n, hash, start, end FROM passages").values() as [number, number, Uint8Array, number, number][]
    const keep = rows.filter((r) => index.has(Buffer.from(r[2]).toString("hex")))
    const n = keep.length
    v.file = new Int32Array(n)
    v.start = new Int32Array(n)
    v.end = new Int32Array(n)
    v.vector = new Int32Array(n)
    v.modality = new Uint8Array(n)
    v.setsScale = new Uint8Array(n)
    keep.forEach(([file, num, hash, start, end], i) => {
      const image = start < 0
      // An image's own vector belongs to the image's file (stored as its negative id).
      v.file[i] = image ? -file : file
      v.start[i] = start
      v.end[i] = end
      v.vector[i] = index.get(Buffer.from(hash).toString("hex"))!
      v.modality[i] = image ? 1 : 0
      v.setsScale[i] = image || num < SCALE_PASSAGES ? 1 : 0
    })
    v.completeSeq = getMeta(db, "complete_seq")
    v.complete = !!v.completeSeq
    for (const [file, sig, upto, total] of db.query("SELECT file, sig, upto, total FROM files").values() as [number, string, number, number][]) {
      v.sigs.set(file, sig)
      if (upto < total) v.complete = false
    }
    return v
  }

  /** Cosine similarity of `query` (L2-normalized) with every passage. */
  score(query: Float32Array): Float32Array {
    const dim = this.dim
    const distinct = this.distinct
    const byVector = new Float32Array(distinct)
    if (query.length === dim) {
      const values = this.values
      for (let k = 0; k < distinct; k++) {
        let s = 0
        const base = k * dim
        for (let d = 0; d < dim; d++) s += values[base + d]! * query[d]!
        byVector[k] = s
      }
    }
    const out = new Float32Array(this.size)
    for (let i = 0; i < out.length; i++) out[i] = byVector[this.vector[i]!]!
    return out
  }
}

/**
 * The semantic index for searches, reloaded when the indexer has changed it (at most every few
 * seconds while an index run writes to it).
 */
export class SemanticVectors {
  private db: Database | null = null
  private version = -1
  private loadedAt = 0
  private index: VectorIndex | null = null
  private generation: string | null = null
  private ino: number | null = null

  constructor(private path: string, private minReloadMs = 3000) {}

  /**
   * The vectors, if they belong to the main index as it is (`generation`, see `mainGeneration`):
   * after a rebuild, file ids mean other files until the next semantic pass.
   */
  get(generation: string | null, completeSequence?: string): VectorIndex | null {
    const index = this.load(completeSequence)
    return index && generation !== null && this.generation === generation ? index : null
  }

  private load(completeSequence?: string): VectorIndex | null {
    // Removed, or removed and made again (`zsearch semantic remove`, then install): an open
    // connection would go on reading the deleted file, so follow the file itself.
    const ino = fileIno(this.path)
    if (this.db && ino !== this.ino) this.close()
    if (ino === null) return null
    if (!this.db) {
      try { this.db = openSemanticDb(this.path, { readonly: true }) } catch { this.db = null }
      if (!this.db) return null
      this.ino = ino
    }
    try {
      // Do not load a growing Granite vector table just to discard it. Its completion
      // marker is cleared before indexing and published only after the entire pass.
      if (completeSequence !== undefined && getMeta(this.db, "complete_seq") !== completeSequence) return null
      const dv = (this.db.query("PRAGMA data_version").get() as { data_version: number }).data_version
      if (this.index && (dv === this.version || Date.now() - this.loadedAt < this.minReloadMs)) return this.index
      const hasTables = this.db.query("SELECT 1 FROM sqlite_master WHERE name = 'passages'").get()
      this.db.transaction(() => {
        this.index = hasTables ? VectorIndex.load(this.db!) : new VectorIndex()
        this.generation = hasTables ? getMeta(this.db!, "generation") : null
      })()
      this.version = dv
      this.loadedAt = Date.now()
    } catch {
      // Being rebuilt, or removed: complete Granite must not fall back to a stale snapshot.
      if (completeSequence !== undefined) return null
    }
    return this.index
  }

  close() {
    try { this.db?.close() } catch {}
    this.db = null
    this.index = null
    this.generation = null
    this.version = -1
    this.ino = null
  }
}

function fileIno(path: string): number | null {
  if (path === ":memory:") return 0
  try { return statSync(path).ino } catch { return null }
}

/* ---------------------------------------------------- query vectors -- */

/**
 * Each model's best passage, discounted for document length and boilerplate, then combined
 * per file. `usable` enforces filters and content authorization before evidence is retained.
 * Optional comparison parts can exclude stale files with `outdated`.
 * `anchored` identifies Potion for optional comparison pipelines; production uses finite scores.
 */
export function bestByFile(parts: { index: VectorIndex; z: Float64Array; tier: "fast" | "full"; outdated?: Set<number>; anchored?: boolean }[], usable: (file: number) => boolean, ranking: Ranking = RANKING): Map<number, { z: number; row: number; index: VectorIndex; anchored: boolean; gateZ?: number }> {
  type Best = { z: number; row: number; index: VectorIndex; anchored: boolean; gateZ?: number }
  const tiers = { fast: new Map<number, Best>(), full: new Map<number, Best>() }
  const ok = new Map<number, boolean>()
  for (const { index, z, tier, outdated, anchored } of parts) {
    const best = tiers[tier]
    for (let row = 0; row < z.length; row++) {
      const file = index.file[row]!
      if (outdated?.has(Math.abs(file))) continue
      const b = best.get(file)
      if (b && b.z >= z[row]!) continue
      let allowed = ok.get(file)
      if (allowed === undefined) ok.set(file, (allowed = usable(file)))
      if (allowed) best.set(file, { z: z[row]!, row, index, anchored: anchored ?? tier === "fast" })
    }
    // Discount once after finding this tier's best passage, including shared boilerplate.
  }
  for (const tier of ["fast", "full"] as const) {
    const length = tier === "fast" ? (ranking.fastLength ?? ranking.length) : ranking.length
    for (const b of tiers[tier].values()) b.z -= length * Math.log(Math.max(b.index.passages(b.index.file[b.row]!), 1)) + ranking.shared * Math.log(Math.max(b.index.sharing(b.row), 1))
  }
  const best = new Map(tiers.fast)
  for (const [file, full] of tiers.full) {
    const fast = tiers.fast.get(file)
    const blend = Math.max(0, Math.min(1, ranking.fastBlend ?? 0))
    if (fast && blend) {
      // One model may recognize a concept the other does not. Preserve its recall gate,
      // while both models still contribute to the final order.
      full.gateZ = Math.max(full.z, fast.z)
      full.z = (1 - blend) * full.z + blend * fast.z
    }
    best.set(file, full)
  }
  return best
}

/** Turns a query into its vector with a model, started on the first query and stopped when idle. */
export class QueryEmbedder {
  private embedder: TextEmbedder | null = null
  private idle: ReturnType<typeof setTimeout> | null = null
  private cache = new Map<string, Float32Array>()

  constructor(private start: () => TextEmbedder, private idleMs = 120_000) {}

  async embed(text: string): Promise<Float32Array> {
    const key = text.trim().replace(/\s+/g, " ")
    const hit = this.cache.get(key)
    if (hit) return hit
    this.embedder ??= this.start()
    if (this.idle) clearTimeout(this.idle)
    try {
      const { vectors } = await this.embedder.embedTexts([queryPrompt(key)])
      if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, vectors)
      return vectors
    } catch (err) {
      this.embedder?.kill()
      this.embedder = null
      throw err
    } finally {
      this.idle = setTimeout(() => this.close(), this.idleMs)
      this.idle.unref?.()
    }
  }


  close() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    this.embedder?.close()
    this.embedder = null
  }
}
