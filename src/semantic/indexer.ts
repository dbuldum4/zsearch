/**
 * The semantic passes of an index run: after the main index has read the files' text, embed what
 * is new or changed, and keep the semantic indexes (`store.ts`) in step with the main one. There
 * are two passes, one per model (`model.ts`): Potion first, which reads everything in moments, then
 * Granite, which takes far longer and whose vectors search prefers for the files it has done.
 *
 * DigUp reads and embeds one file at a time, up to 16 passages per model call, and reads each
 * file again for it. This pass is built to do much less work for the same vectors:
 *
 * - It reads the text the main index already extracted, rather than opening the files again.
 * - Passages from many files go to the helper together; the helper sorts them by length and packs
 *   them into as few model calls as fit, and the next group is prepared while one runs.
 * - Files are cut into passages on worker threads (`workers.ts`), which also run Potion: this
 *   thread only checks which passages are new and stores them.
 * - A passage is embedded once, wherever it appears: by a hash of the exact text the model reads,
 *   so copies of a file, boilerplate shared between files, and files that were renamed, moved or
 *   re-indexed from scratch cost nothing more. An edited file only has its edited passages embedded.
 * - Passages don't overlap (see `chunk.ts`), and text that is mostly digits is left to keyword search.
 * - Source code and data files are left out unless `semantic.code` is on (as DigUp's code search
 *   is off by default), and Lean proofs always are (see `semanticExcluded`).
 *
 * Like the main index it respects the index settings: it runs only as part of an index run (so
 * not at all with "only when I ask" until someone asks), and so only while zsearch runs (the Mac
 * app is open); the Granite pass waits on power in a background run with a lot to do; neither reads
 * keys and password files (they have no stored text); and both stop at once when the run is
 * cancelled. Long files get their first passages in a first round and the rest after every file has
 * its start, as DigUp does.
 */
import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { availableParallelism } from "node:os"
import type { Config } from "../config.ts"
import { ContentState, getMeta as getMainMeta, setMeta as setMainMeta } from "../index/db.ts"
import { loadShare } from "../index/load.ts"
import type { PowerGate } from "../index/power.ts"
import { crawlOptionsFor, policyFor } from "../index/policy.ts"
import { secretFile } from "../index/secrets.ts"
import { type Kind, semanticExcluded } from "../kinds.ts"
import { CHUNK_CHARS, CHUNKER_VERSION } from "./chunk.ts"
import type { Cut, CutJob } from "./cut.ts"
import { Embedder, type TextEmbedder } from "./helper.ts"
import { installedModel, modelFingerprint, modelSpec, POTION, type Tier } from "./model.ts"
import { SemanticWorkers } from "./workers.ts"
import { clearAll, clearPassages, getMeta, openSemanticDb, packVector, semanticDbPath, setMeta } from "./store.ts"

/** Kinds whose text is embedded (images: the text OCR read in them). Code and data files only with `semantic.code`. */
const TEXT_KINDS = new Set<Kind>(["text", "markdown", "web", "pdf", "doc", "sheet", "slides", "ebook", "email", "image", "other"])
const CODE_KINDS = new Set<Kind>(["code", "data"])
/** Passages of a file in the first round (DigUp's `docStep`); the rest come in the second. */
const FIRST_ROUND = 40
/** Passages after which a file's passages stop setting the scale of meaning scores (see `search.ts`). */
export const SCALE_PASSAGES = FIRST_ROUND
/**
 * Characters of text to cut into passages for one group, about: Granite's helper is sent each
 * group's new passages (about 280) and packs them into model calls, while Potion's are embedded by
 * the workers, for whom a bigger group costs fewer messages and commits.
 */
const GROUP_CHARS: Record<Tier, number> = { full: 512 * 1024, fast: 8 << 20 }
/** Passages, at most, sent to the helper in one request. */
const REQUEST_INPUTS = 256
/** Files to embed, at least, for a background Granite run to wait on power. Embedding costs far more per file than reading. */
const BIG_RUN = 100
/** Potion's version here: bump it with anything that changes its vectors (`potion.ts`). */
const POTION_VERSION = 1

export interface SemanticProgress {
  /** Which pass: Potion's ("fast") or Granite's ("full"). */
  tier?: Tier
  /** Files to embed in this run, and done so far. */
  total: number
  done: number
  /** Passages embedded, and found already embedded. */
  embedded: number
  reused: number
  waiting?: string
  current: string
}

export interface SemanticOptions {
  /** Which model's pass: "fast" (Potion) or "full" (Granite, the default). */
  tier?: Tier
  signal?: AbortSignal
  /** Wait on power during a big pass (background runs). */
  power?: PowerGate
  /** Someone asked for this run while it waited: stop waiting. */
  goNow?: () => boolean
  onProgress?: (p: SemanticProgress) => void
  onCommit?: () => void
  /** Starts the model (tests and benchmarks pass their own). */
  embedder?: (opts: { threads: number; low: boolean }) => TextEmbedder
  /** The helper's `VECTOR_VERSION`, when `embedder` is given. */
  vectorVersion?: number
  /** Run at a low priority (background runs). */
  low?: boolean
}

export interface SemanticSummary {
  status: "done" | "cancelled" | "skipped" | "error"
  files: number
  embedded: number
  reused: number
  removed: number
  tokens: number
  error?: string
}

/** Whether semantic indexing can run with these settings: the setting, and Potion at least. */
export function semanticAvailable(config: Config, tool: string | null): string | null {
  if (!config.semantic.enabled) return "semantic search is off"
  if (!config.content.enabled) return "file contents are off"
  if (!installedModel(POTION)) return "the models are not downloaded (zsearch semantic install)"
  return tierBlocked("full", tool) && tierBlocked("fast", tool)
}

/** Why one model's pass can't run (its files, and Granite's helper), or null. */
export function tierBlocked(tier: Tier, tool: string | null): string | null {
  if (!installedModel(modelSpec(tier))) return `${modelSpec(tier).name} is not downloaded (zsearch semantic install)`
  if (tier === "full" && !tool) return "the embedding helper (zsearch-embed) is not installed"
  return null
}

/** The helper's VECTOR_VERSION, from `zsearch-embed --version`, which loads nothing. */
export function helperVectorVersion(tool: string): number {
  try {
    const r = Bun.spawnSync([tool, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 5000 })
    const m = /vectors (\d+)/.exec(r.stdout.toString())
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

/**
 * Which main index (and which build of it) the semantic index's file ids belong to: a key of the
 * index file's own, which a new or upgraded index doesn't have, and its generation, which a
 * rebuild in place moves on. `create`: give the index its key if it has none.
 */
export function mainGeneration(main: Database, create = false): string | null {
  let key = getMainMeta(main, "semantic_key")
  if (!key) {
    if (!create) return null
    key = randomUUID()
    setMainMeta(main, "semantic_key", key)
  }
  return `${key}:${getMainMeta(main, "generation") ?? "0"}`
}

export function semanticFingerprint(tier: Tier, vectorVersion: number): string {
  return `${modelFingerprint(modelSpec(tier))} vectors${vectorVersion} chunks${CHUNKER_VERSION}`
}

/** What a file's passages are read from: its size, date and text length. */
export function textSig(size: number, mtime: number, len: number): string {
  return `t:${size}:${mtime}:${len}`
}

interface Candidate {
  id: number
  path: string
  name: string
  kind: Kind
  sig: string
  mtime: number
  /** Characters of stored text. */
  len: number
}

interface Queued extends Candidate {
  /** Passages read already, with this signature. */
  from: number
  /** All its passages, once this run has cut its text: round two skips the files it finished. */
  total?: number
}

/** One passage needing a vector, and the files waiting for it. */
interface Need {
  prompt: string
  hash: Uint8Array
}

/** A file's passages for this round, ready to be stored once their vectors are. */
interface Pending {
  file: Queued
  total: number
  to: number
  rows: { n: number; hash: Uint8Array; start: number; end: number }[]
  /** Hashes still waiting for a vector (embedded in this group or one before it). */
  waiting: Map<string, Uint8Array>
  note?: string
}

const hex = (h: Uint8Array) => Buffer.from(h).toString("hex")

export class SemanticIndexer {
  private progress: SemanticProgress
  private lastEmit = 0
  private embedder: TextEmbedder | null = null
  /** The workers that cut files into passages (and, for Potion, embed them: then they are `embedder` too). */
  private workers: SemanticWorkers | null = null
  private tokens = 0
  private tier: Tier

  constructor(
    private main: Database,
    private config: Config,
    private tool: string | null,
    private opts: SemanticOptions = {},
  ) {
    this.tier = opts.tier ?? "full"
    this.progress = { tier: this.tier, total: 0, done: 0, embedded: 0, reused: 0, current: "" }
  }

  private get aborted() {
    return this.opts.signal?.aborted ?? false
  }

  private emit(force = false) {
    const now = Date.now()
    if (!force && now - this.lastEmit < 100) return
    this.lastEmit = now
    this.opts.onProgress?.({ ...this.progress })
  }

  private waitReason(big: boolean): string | undefined {
    // Potion costs next to nothing: only Granite waits on power.
    if (!big || this.tier === "fast" || this.opts.goNow?.()) return undefined
    return this.opts.power?.reason() ?? undefined
  }

  /** Wait while power says to; false if the run was cancelled meanwhile. */
  private async waitPower(big: boolean): Promise<boolean> {
    for (;;) {
      const why = this.waitReason(big)
      if (why !== this.progress.waiting) {
        this.progress.waiting = why
        this.emit(true)
      }
      if (!why) return !this.aborted
      if (this.aborted) return false
      await Bun.sleep(1000)
    }
  }

  /**
   * `job`, or null as soon as the run is cancelled: the helper is killed rather than waited for,
   * so a helper that hangs can't keep the index busy after a cancel.
   */
  private async unlessAborted<T>(job: Promise<T>): Promise<T | null> {
    const signal = this.opts.signal
    if (!signal) return job
    if (signal.aborted) { job.catch(() => {}); this.killEmbedder(); return null }
    let onAbort = () => {}
    const aborted = new Promise<null>((resolve) => { onAbort = () => resolve(null); signal.addEventListener("abort", onAbort, { once: true }) })
    try {
      const r = await Promise.race([job, aborted])
      if (signal.aborted) { job.catch(() => {}); this.killEmbedder(); return null }
      return r
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }

  private killEmbedder() {
    this.embedder?.kill()
    this.embedder = null
    this.workers?.kill()
    this.workers = null
  }

  private threads() {
    return Math.max(1, Math.round(availableParallelism() * loadShare(this.config.indexLoad)))
  }

  private startWorkers(): SemanticWorkers {
    if (this.workers) return this.workers
    if (this.tier === "fast" && !this.opts.embedder) {
      const [model, tokenizer] = installedModel(POTION)!
      this.workers = new SemanticWorkers(this.threads(), { model: model!, tokenizer: tokenizer! })
    } else {
      // Granite's helper takes the cores: cutting is a small part of its pass.
      this.workers = new SemanticWorkers(this.tier === "fast" ? this.threads() : 1)
    }
    return this.workers
  }

  private startEmbedder(): TextEmbedder {
    if (this.embedder) return this.embedder
    const threads = this.threads()
    const low = this.opts.low ?? loadShare(this.config.indexLoad) < 1
    if (this.opts.embedder) this.embedder = this.opts.embedder({ threads, low })
    else if (this.tier === "fast") this.embedder = this.startWorkers()
    else this.embedder = new Embedder({ tool: this.tool!, model: installedModel(modelSpec("full"))![0]!, pooling: "cls", threads, low })
    return this.embedder
  }

  async run(): Promise<SemanticSummary> {
    const summary: SemanticSummary = { status: "done", files: 0, embedded: 0, reused: 0, removed: 0, tokens: 0 }
    const dbPath = this.main.filename && this.main.filename !== "" ? this.main.filename : ":memory:"
    const store = openSemanticDb(semanticDbPath(dbPath, this.tier))!
    try {
      return await this.runWith(store, summary)
    } catch (err) {
      const message = (err as Error).message
      try { setMeta(store, "last_error", message) } catch {}
      return { ...summary, status: "error", error: message }
    } finally {
      this.embedder?.close()
      this.embedder = null
      this.workers?.close()
      this.workers = null
      store.close()
    }
  }

  private async runWith(store: Database, summary: SemanticSummary): Promise<SemanticSummary> {
    const version = this.opts.vectorVersion ?? (this.tier === "fast" ? POTION_VERSION : this.tool ? helperVectorVersion(this.tool) : 0)
    const fingerprint = semanticFingerprint(this.tier, version)
    if (getMeta(store, "fingerprint") !== fingerprint) {
      // Vectors of another model or helper can't be compared with new ones.
      clearAll(store)
      setMeta(store, "fingerprint", fingerprint)
    }
    const generation = mainGeneration(this.main, true)!
    if (getMeta(store, "generation") !== generation) {
      // The main index was rebuilt: new file ids. The vectors stay, for the same passages.
      clearPassages(store)
      setMeta(store, "generation", generation)
    }

    setMeta(store, "complete_seq", "")
    setMeta(store, "indexing_seq", getMainMeta(this.main, "change_seq") ?? "0")
    const candidates = this.candidates()
    const known = new Map<number, { sig: string; upto: number; total: number }>()
    for (const r of store.query("SELECT file, sig, upto, total FROM files").all() as { file: number; sig: string; upto: number; total: number }[]) known.set(r.file, r)
    const wanted = new Set(candidates.map((c) => c.id))
    const gone = [...known.keys()].filter((id) => !wanted.has(id))
    if (gone.length) {
      const delP = store.prepare("DELETE FROM passages WHERE file = ?")
      const delF = store.prepare("DELETE FROM files WHERE file = ?")
      store.transaction(() => { for (const id of gone) { delP.run(id); delF.run(id) } })()
      summary.removed = gone.length
      this.opts.onCommit?.()
    }
    const queue: Queued[] = []
    for (const c of candidates) {
      const k = known.get(c.id)
      if (!k || k.sig !== c.sig) queue.push({ ...c, from: 0 })
      else if (k.upto < k.total) queue.push({ ...c, from: k.upto })
    }
    // Newest first.
    queue.sort((a, b) => b.mtime - a.mtime)
    this.progress.total = queue.length
    this.emit(true)
    if (!queue.length) {
      this.finish(store, true)
      return summary
    }
    const big = queue.length >= BIG_RUN
    if (!(await this.waitPower(big))) return { ...summary, status: "cancelled" }

    const stats = { files: new Set<number>() }
    // Round one: every file's first passages. Round two: the rest of the long ones.
    for (const cap of [FIRST_ROUND, Infinity]) {
      if (!(await this.textRound(store, queue, cap, big, stats))) return this.cancelled(summary, stats)
    }
    this.finish(store, true)
    return { ...summary, files: stats.files.size, embedded: this.progress.embedded, reused: this.progress.reused, tokens: this.tokens }
  }

  private cancelled(summary: SemanticSummary, stats: { files: Set<number> }): SemanticSummary {
    return { ...summary, status: "cancelled", files: stats.files.size, embedded: this.progress.embedded, reused: this.progress.reused, tokens: this.tokens }
  }

  private finish(store: Database, complete: boolean) {
    if (complete) {
      // Vectors no passage uses any more: of deleted files and edited passages.
      store.exec("DELETE FROM vectors WHERE hash NOT IN (SELECT hash FROM passages)")
      setMeta(store, "complete_seq", getMeta(store, "indexing_seq") ?? "0")
      setMeta(store, "last_run_at", String(Date.now()))
      setMeta(store, "last_error", "")
    }
    store.exec("PRAGMA wal_checkpoint(PASSIVE)")
    this.opts.onCommit?.()
  }

  /** The files that should have vectors, with what their vectors depend on. */
  private candidates(): Candidate[] {
    const kinds = new Set(TEXT_KINDS)
    if (this.config.semantic.code) for (const k of CODE_KINDS) kinds.add(k)
    // One checker for them all: it resolves the roots and exclusions once, not once a file.
    const policy = policyFor(crawlOptionsFor(this.config))
    const out: Candidate[] = []
    const rows = this.main
      .query("SELECT id, path, name, kind, size, mtime, content_len AS len, source_path AS source FROM files WHERE is_dir = 0 AND content_state = ? AND content_len > 0")
      .all(ContentState.Indexed) as { id: number; path: string; name: string; kind: Kind; size: number; mtime: number; len: number; source: string }[]
    for (const r of rows) {
      if (!kinds.has(r.kind) || semanticExcluded(r.path)) continue
      const p = policy(r.path)
      if (p.allowed && p.content && !secretFile(r.path) && (!r.source || r.source === p.real)) out.push({ id: r.id, path: r.path, name: r.name, kind: r.kind, sig: textSig(r.size, r.mtime, r.len), mtime: r.mtime, len: r.len })
    }
    return out
  }

  /* ----------------------------------------------------------- text -- */

  private async textRound(store: Database, files: Queued[], cap: number, big: boolean, stats: { files: Set<number> }): Promise<boolean> {
    const hasVector = store.prepare("SELECT 1 FROM vectors WHERE hash = ?")
    const readContent = this.main.prepare("SELECT data FROM content WHERE id = ?")
    // Hashes asked for and not stored yet, across groups, with the prompt to embed.
    const inFlight = new Set<string>()
    let next = 0
    /** Start cutting the next files, about a group's worth of text, in the workers. */
    const startCut = (): { batch: Queued[]; cuts: Promise<Cut[] | null> } | null => {
      const batch: Queued[] = []
      const jobs: CutJob[] = []
      let chars = 0
      while (next < files.length && chars < GROUP_CHARS[this.tier]) {
        const file = files[next++]!
        // Finished in round one.
        if (file.total !== undefined && file.from >= file.total) continue
        const row = readContent.get(file.id) as { data: Uint8Array } | null
        if (!row) continue
        batch.push(file)
        jobs.push({ data: row.data, name: file.name, from: file.from, cap })
        chars += Math.min(file.len, (cap - file.from) * CHUNK_CHARS)
      }
      if (!batch.length) return null
      const cuts = this.startWorkers().cut(jobs)
      cuts.catch(() => {})
      return { batch, cuts: this.unlessAborted(cuts) }
    }
    /** A group, from files cut: their passages, and the distinct new ones among them. */
    const group = async (started: ReturnType<typeof startCut>): Promise<{ pending: Pending[]; needs: Need[] } | null> => {
      if (!started) return null
      const cuts = await started.cuts
      if (!cuts) return null
      const pending: Pending[] = []
      const needs: Need[] = []
      started.batch.forEach((file, i) => {
        const { total, to, passages } = cuts[i]!
        // Nothing more to read this round (a short file in round two).
        if (file.from >= to && !(file.from === 0 && total === 0)) return
        const p: Pending = { file, total, to, rows: [], waiting: new Map() }
        for (const { n, start, end, prompt, hash } of passages) {
          const key = hex(hash)
          p.rows.push({ n, hash, start, end })
          if (inFlight.has(key)) { p.waiting.set(key, hash); this.progress.reused++; continue }
          if (hasVector.get(hash)) { this.progress.reused++; continue }
          inFlight.add(key)
          p.waiting.set(key, hash)
          needs.push({ prompt, hash })
        }
        pending.push(p)
        this.progress.current = file.path
      })
      return { pending, needs }
    }
    const embed = (g: { needs: Need[] } | null) => {
      if (!g?.needs.length) return null
      const job = this.embedAll(g.needs.map((n) => n.prompt))
      // Left unawaited when the run is cancelled.
      job.catch(() => {})
      return job
    }

    // A pipeline: while one group is embedded, the next is checked and the one after it cut, and
    // while the next is embedded, this one is stored.
    const waitingFiles: Pending[] = []
    let current = await group(startCut())
    if (this.aborted) return false
    let cutting = startCut()
    let job = embed(current)
    while (current) {
      if (this.aborted || !(await this.waitPower(big))) return false
      const { pending, needs } = current
      const following = await group(cutting)
      if (this.aborted) return false
      cutting = startCut()
      const result = job ? await this.unlessAborted(job) : null
      if (this.aborted) return false
      const followingJob = embed(following)
      if (result) this.tokens += result.tokens
      const insertVector = store.prepare("INSERT OR IGNORE INTO vectors(hash, vec) VALUES (?, ?)")
      const done = new Set<string>()
      store.transaction(() => {
        if (result) {
          needs.forEach((need, i) => {
            insertVector.run(need.hash, packVector(result.vectors, i * result.dim, result.dim))
            done.add(hex(need.hash))
          })
        }
        waitingFiles.push(...pending)
        // A file waiting on a passage another group embeds (the one before, while this one was
        // read) is stored once that one is in.
        for (const p of waitingFiles) for (const [key, hash] of p.waiting) if (done.has(key) || hasVector.get(hash)) p.waiting.delete(key)
        for (let i = 0; i < waitingFiles.length;) {
          const p = waitingFiles[i]!
          if (p.waiting.size) { i++; continue }
          this.storeFile(store, p)
          stats.files.add(p.file.id)
          waitingFiles.splice(i, 1)
          if (p.to >= p.total || cap !== Infinity) this.progress.done += p.to >= p.total ? 1 : 0
        }
      })()
      for (const key of done) inFlight.delete(key)
      this.progress.embedded += needs.length
      this.emit()
      this.opts.onCommit?.()
      current = following
      job = followingJob
    }
    // Every passage asked for is in by now; a file still waiting would be finished by the next run.
    if (waitingFiles.length) throw new Error(`${waitingFiles.length} files were left waiting for their passages`)
    return true
  }

  /** The texts' vectors: from the helper, in requests of at most REQUEST_INPUTS. */
  private async embedAll(texts: string[]): Promise<{ vectors: Float32Array; dim: number; tokens: number }> {
    const embedder = this.startEmbedder()
    if (embedder === this.workers || texts.length <= REQUEST_INPUTS) return embedder.embedTexts(texts)
    const parts: { vectors: Float32Array; dim: number; tokens: number }[] = []
    for (let i = 0; i < texts.length; i += REQUEST_INPUTS) parts.push(await embedder.embedTexts(texts.slice(i, i + REQUEST_INPUTS)))
    const dim = parts[0]!.dim
    const vectors = new Float32Array(texts.length * dim)
    parts.forEach((p, k) => vectors.set(p.vectors, k * REQUEST_INPUTS * dim))
    return { vectors, dim, tokens: parts.reduce((t, p) => t + p.tokens, 0) }
  }

  private storeFile(store: Database, p: Pending) {
    const id = p.file.id
    if (p.file.from === 0) store.query("DELETE FROM passages WHERE file = ?").run(id)
    const put = store.prepare("INSERT OR REPLACE INTO passages(file, n, hash, start, end) VALUES (?, ?, ?, ?, ?)")
    for (const r of p.rows) put.run(id, r.n, r.hash, r.start, r.end)
    store.query("INSERT INTO files(file, sig, upto, total, note) VALUES (?, ?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET sig = excluded.sig, upto = excluded.upto, total = excluded.total, note = excluded.note").run(id, p.file.sig, p.to, p.total, p.note ?? null)
    // The next round goes on from here.
    p.file.from = p.to
    p.file.total = p.total
  }
}

/**
 * Both passes of an index run: Potion's, which reads every file in moments, then Granite's, where
 * its helper and model are there. The summary is Granite's (Potion's, without it), with the
 * passages of both; a cancelled or failed Potion pass stops there.
 */
export async function runSemanticPasses(main: Database, config: Config, tool: string | null, opts: Omit<SemanticOptions, "tier"> = {}): Promise<SemanticSummary> {
  let summary: SemanticSummary | null = null
  for (const tier of ["fast", "full"] as const) {
    if (tierBlocked(tier, tool) && !opts.embedder) continue
    const s = await new SemanticIndexer(main, config, tool, { ...opts, tier }).run()
    summary = summary ? { ...s, embedded: summary.embedded + s.embedded, reused: summary.reused + s.reused, tokens: summary.tokens + s.tokens } : s
    if (s.status !== "done") break
  }
  return summary ?? { status: "skipped", files: 0, embedded: 0, reused: 0, removed: 0, tokens: 0 }
}
