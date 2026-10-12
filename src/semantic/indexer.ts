/**
 * The semantic pass of an index run: after the main index has read the files' text, embed what
 * is new or changed with EmbeddingGemma 2, and keep the semantic index (`store.ts`) in step with
 * the main one.
 *
 * DigUp reads and embeds one file at a time, up to 16 passages per model call, and reads each
 * file again for it. This pass is built to do much less work for the same vectors:
 *
 * - It reads the text the main index already extracted, rather than opening the files again.
 * - Passages from many files go to the helper together; the helper sorts them by length and packs
 *   them into as few model calls as fit, and the next group is prepared while one runs.
 * - A passage is embedded once, wherever it appears: by a hash of the exact text the model reads,
 *   so copies of a file, boilerplate shared between files, and files that were renamed, moved or
 *   re-indexed from scratch cost nothing more. An edited file only has its edited passages embedded.
 * - Passages don't overlap (see `chunk.ts`), and text that is mostly digits is left to keyword search.
 * - Source code and data files are left out unless `semantic.code` is on (as DigUp's code search
 *   is off by default).
 *
 * Like the main index it respects the index settings: it runs only as part of an index run (so
 * not at all with "only when I ask" until someone asks), waits on power in a background run with
 * a lot to do, never reads keys and password files (they have no stored text), and stops at once
 * when the run is cancelled. Long files get their first passages in a first round and the rest
 * after every file has its start, as DigUp does.
 */
import type { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { availableParallelism } from "node:os"
import { closeSync, openSync, readSync } from "node:fs"
import { type Config, resolvePath } from "../config.ts"
import { ContentState, decompressText, getMeta as getMainMeta, setMeta as setMainMeta } from "../index/db.ts"
import { datasetFolders, DATASET_NOTE } from "../index/datasets.ts"
import { loadShare } from "../index/load.ts"
import type { PowerGate } from "../index/power.ts"
import { crawlOptionsFor, pathPolicy } from "../index/policy.ts"
import { SECRET_NOTE, secretFile } from "../index/secrets.ts"
import { extOf, type Kind, OCR_EXTS } from "../kinds.ts"
import { CHUNKER_VERSION, chunkText, documentPrompt, hasWords, titleOf } from "./chunk.ts"
import { Embedder, type EmbedderOptions } from "./helper.ts"
import { installedModel, modelFingerprint } from "./model.ts"
import { clearAll, clearPassages, getMeta, openSemanticDb, packVector, semanticDbPath, setMeta } from "./store.ts"

/** Kinds whose text is embedded. Code and data files only with `semantic.code`. */
const TEXT_KINDS = new Set<Kind>(["text", "markdown", "web", "pdf", "doc", "sheet", "slides", "ebook", "email", "image", "other"])
const CODE_KINDS = new Set<Kind>(["code", "data"])
/** Passages of a file in the first round (DigUp's `docStep`); the rest come in the second. */
const FIRST_ROUND = 40
/** Passages after which a file's passages stop setting the scale of meaning scores (see `search.ts`). */
export const SCALE_PASSAGES = FIRST_ROUND
/** Passages, at most, sent to the helper in one request: it packs them into model calls. */
const GROUP_INPUTS = 256
/** ...and characters. */
const GROUP_CHARS = 512 * 1024
/** Images per request (as DigUp batches them). */
const IMAGE_GROUP = 8
/** Files to embed, at least, for a background run to wait on power. Embedding costs far more per file than reading. */
const BIG_RUN = 100
/** Image files are hashed (to share vectors between copies) from at most their first bytes. */
const IMAGE_HASH_BYTES = 64 * 1024 * 1024

export interface SemanticProgress {
  /** Files to embed in this run, and done so far. */
  total: number
  done: number
  /** Passages and images embedded, and found already embedded. */
  embedded: number
  reused: number
  waiting?: string
  current: string
}

export interface SemanticOptions {
  signal?: AbortSignal
  /** Wait on power during a big pass (background runs). */
  power?: PowerGate
  /** Someone asked for this run while it waited: stop waiting. */
  goNow?: () => boolean
  onProgress?: (p: SemanticProgress) => void
  onCommit?: () => void
  /** Starts the helper (tests and benchmarks pass their own). */
  embedder?: (opts: Omit<EmbedderOptions, "tool" | "model">) => Embedder
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

/** Whether semantic indexing can run with these settings: the model, the helper and the setting. */
export function semanticAvailable(config: Config, tool: string | null): string | null {
  if (!config.semantic.enabled) return "semantic search is off"
  if (!config.content.enabled) return "file contents are off"
  if (!tool) return "the embedding helper (zsearch-embed) is not installed"
  if (!installedModel().text) return "the model is not downloaded (zsearch semantic install)"
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

export function semanticFingerprint(vectorVersion: number): string {
  return `${modelFingerprint()} vectors${vectorVersion} chunks${CHUNKER_VERSION}`
}

interface Candidate {
  id: number
  path: string
  name: string
  kind: Kind
  sig: string
  image: boolean
  mtime: number
}

interface Queued extends Candidate {
  /** Passages read already, with this signature. */
  from: number
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
  /** Hashes still waiting for a vector. */
  waiting: Set<string>
  note?: string
}

const hex = (h: Uint8Array) => Buffer.from(h).toString("hex")

function hashText(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s).digest().subarray(0, 16))
}

/** A hash of an image file's bytes and how it is embedded, or null when it can't be read. */
function hashImage(path: string, budget: number): Uint8Array | null {
  let fd: number
  try { fd = openSync(path, "r") } catch { return null }
  try {
    const h = createHash("sha256").update(`image:${budget}:`)
    const buf = new Uint8Array(1 << 20)
    let pos = 0
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos)
      if (!n) break
      h.update(buf.subarray(0, n))
      pos += n
      if (pos >= IMAGE_HASH_BYTES) break
    }
    return new Uint8Array(h.digest().subarray(0, 16))
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** Screenshots get twice the image tokens of photos, as in DigUp: they hold small text. */
export function imageBudget(name: string): number {
  return /^(?:screen ?shot|cleanshot|capture d['’]écran|bildschirmfoto|schermata)/i.test(name) ? 280 : 140
}

export class SemanticIndexer {
  private progress: SemanticProgress = { total: 0, done: 0, embedded: 0, reused: 0, current: "" }
  private lastEmit = 0
  private embedder: Embedder | null = null
  private tokens = 0

  constructor(
    private main: Database,
    private config: Config,
    private tool: string | null,
    private opts: SemanticOptions = {},
  ) {}

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
    if (!big || this.opts.goNow?.()) return undefined
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

  private startEmbedder(images: boolean): Embedder {
    if (this.embedder) return this.embedder
    const cores = availableParallelism()
    const threads = Math.max(1, Math.round(cores * loadShare(this.config.indexLoad)))
    const model = installedModel()
    const mmproj = images ? model.media : null
    const low = this.opts.low ?? loadShare(this.config.indexLoad) < 1
    this.embedder = this.opts.embedder ? this.opts.embedder({ mmproj, threads, low }) : new Embedder({ tool: this.tool!, model: model.text!, mmproj, threads, low })
    return this.embedder
  }

  async run(): Promise<SemanticSummary> {
    const summary: SemanticSummary = { status: "done", files: 0, embedded: 0, reused: 0, removed: 0, tokens: 0 }
    const dbPath = this.main.filename && this.main.filename !== "" ? this.main.filename : ":memory:"
    const store = openSemanticDb(semanticDbPath(dbPath))!
    try {
      return await this.runWith(store, summary)
    } catch (err) {
      const message = (err as Error).message
      try { setMeta(store, "last_error", message) } catch {}
      return { ...summary, status: "error", error: message }
    } finally {
      this.embedder?.close()
      this.embedder = null
      store.close()
    }
  }

  private async runWith(store: Database, summary: SemanticSummary): Promise<SemanticSummary> {
    const version = this.opts.vectorVersion ?? (this.tool ? helperVectorVersion(this.tool) : 0)
    const fingerprint = semanticFingerprint(version)
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
    // Text first, newest first; then images, newest first.
    queue.sort((a, b) => Number(a.image) - Number(b.image) || b.mtime - a.mtime)
    this.progress.total = queue.length
    this.emit(true)
    if (!queue.length) {
      this.finish(store, true)
      return summary
    }
    const big = queue.length >= BIG_RUN
    if (!(await this.waitPower(big))) return { ...summary, status: "cancelled" }

    const texts = queue.filter((q) => !q.image)
    const images = queue.filter((q) => q.image)
    const stats = { files: new Set<number>() }
    // Round one: every file's first passages. Round two: the rest of the long ones.
    for (const cap of [FIRST_ROUND, Infinity]) {
      if (!(await this.textRound(store, texts, cap, big, stats))) return this.cancelled(summary, stats)
    }
    if (images.length && !(await this.imageRound(store, images, big, stats))) return this.cancelled(summary, stats)
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
    const crawl = crawlOptionsFor(this.config)
    const out: Candidate[] = []
    const rows = this.main
      .query("SELECT id, path, name, ext, kind, size, mtime, content_state AS state, content_len AS len, note, source_path AS source FROM files WHERE is_dir = 0 AND (content_state = ? OR kind = 'image')")
      .all(ContentState.Indexed) as { id: number; path: string; name: string; ext: string; kind: Kind; size: number; mtime: number; state: number; len: number; note: string | null; source: string }[]
    const images = this.imagesWanted()
    const imageRows = images ? rows.filter((r) => r.kind === "image" && OCR_EXTS.has(r.ext) && r.note !== SECRET_NOTE && r.note !== DATASET_NOTE) : []
    // Without OCR, dataset folders weren't looked for: look here, as `skipDatasetOcr` asks.
    const datasets = new Set(imageRows.length && this.config.skipDatasetOcr ? datasetFolders(imageRows.map((r) => r.path), crawl.roots.map((r) => resolvePath(r))).map((d) => d.dir) : [])
    for (const r of rows) {
      const allowed = () => {
        const p = pathPolicy(r.path, crawl)
        return p.allowed && p.content && !secretFile(r.path) && (!r.source || r.source === p.real)
      }
      if (r.state === ContentState.Indexed && r.len > 0 && kinds.has(r.kind) && allowed()) out.push({ id: r.id, path: r.path, name: r.name, kind: r.kind, sig: `t:${r.size}:${r.mtime}:${r.len}`, image: false, mtime: r.mtime })
      // An image also gets a vector of its own, of what it shows (with its OCR text, if any, as a passage above).
      if (images && r.kind === "image" && OCR_EXTS.has(extOf(r.name)) && r.note !== SECRET_NOTE && r.note !== DATASET_NOTE && !datasets.has(r.path.slice(0, r.path.lastIndexOf("/"))) && allowed()) {
        out.push({ id: -r.id, path: r.path, name: r.name, kind: r.kind, sig: `i:${r.size}:${r.mtime}:${imageBudget(r.name)}`, image: true, mtime: r.mtime })
      }
    }
    return out
  }

  /** Images get vectors with the image encoder downloaded, a helper that can read them, and the setting on. */
  private imagesWanted(): boolean {
    return this.config.semantic.images && (this.opts.embedder !== undefined || (installedModel().media !== null && process.platform === "darwin"))
  }

  /* ----------------------------------------------------------- text -- */

  private async textRound(store: Database, files: Queued[], cap: number, big: boolean, stats: { files: Set<number> }): Promise<boolean> {
    const hasVector = store.prepare("SELECT 1 FROM vectors WHERE hash = ?")
    const readContent = this.main.prepare("SELECT data FROM content WHERE id = ?")
    // Hashes asked for and not stored yet, across groups, with the prompt to embed.
    const inFlight = new Set<string>()
    let next = 0
    /** Build the next group: files' passages, and the distinct new ones among them. */
    const build = (): { pending: Pending[]; needs: Need[] } | null => {
      const pending: Pending[] = []
      const needs: Need[] = []
      let chars = 0
      while (next < files.length && needs.length < GROUP_INPUTS && chars < GROUP_CHARS) {
        const file = files[next++]!
        const row = readContent.get(file.id) as { data: Uint8Array } | null
        if (!row) continue
        const text = decompressText(row.data)
        const chunks = chunkText(text)
        const from = file.from
        const to = Math.min(chunks.length, Math.max(from, cap === Infinity ? chunks.length : cap))
        if (from >= to && !(from === 0 && chunks.length === 0)) {
          // Nothing more to read this round (a short file in round two).
          continue
        }
        const title = titleOf(file.name)
        const p: Pending = { file, total: chunks.length, to, rows: [], waiting: new Set() }
        for (let n = from; n < to; n++) {
          const c = chunks[n]!
          if (!hasWords(c.text)) continue
          const prompt = documentPrompt(title, c.text)
          const hash = hashText(prompt)
          const key = hex(hash)
          p.rows.push({ n, hash, start: c.start, end: c.end })
          if (inFlight.has(key)) { p.waiting.add(key); this.progress.reused++; continue }
          if (hasVector.get(hash)) { this.progress.reused++; continue }
          inFlight.add(key)
          p.waiting.add(key)
          needs.push({ prompt, hash })
          chars += prompt.length
        }
        pending.push(p)
        this.progress.current = file.path
      }
      return pending.length ? { pending, needs } : null
    }

    const waitingFiles: Pending[] = []
    let group = build()
    while (group) {
      if (this.aborted || !(await this.waitPower(big))) return false
      const { pending, needs } = group
      // The model works on this group while the next one is read and cut.
      const job = needs.length ? this.startEmbedder(this.imagesWanted()).embedTexts(needs.map((n) => n.prompt)) : null
      const following = build()
      const result = job ? await job : null
      if (this.aborted) return false
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
        for (const p of waitingFiles) for (const key of done) p.waiting.delete(key)
        // A file waiting on a passage another group embeds is stored once that one is in.
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
      group = following
    }
    return true
  }

  private storeFile(store: Database, p: Pending) {
    const id = p.file.id
    if (p.file.from === 0) store.query("DELETE FROM passages WHERE file = ?").run(id)
    const put = store.prepare("INSERT OR REPLACE INTO passages(file, n, hash, start, end) VALUES (?, ?, ?, ?, ?)")
    for (const r of p.rows) put.run(id, r.n, r.hash, r.start, r.end)
    store.query("INSERT INTO files(file, sig, upto, total, note) VALUES (?, ?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET sig = excluded.sig, upto = excluded.upto, total = excluded.total, note = excluded.note").run(id, p.file.sig, p.to, p.total, p.note ?? null)
    // The next round goes on from here.
    p.file.from = p.to
  }

  /* --------------------------------------------------------- images -- */

  private async imageRound(store: Database, files: Queued[], big: boolean, stats: { files: Set<number> }): Promise<boolean> {
    const hasVector = store.prepare("SELECT 1 FROM vectors WHERE hash = ?")
    const insertVector = store.prepare("INSERT OR IGNORE INTO vectors(hash, vec) VALUES (?, ?)")
    // Same budget together: one request is one budget.
    const byBudget = new Map<number, Queued[]>()
    for (const f of files) {
      const b = imageBudget(f.name)
      const list = byBudget.get(b) ?? []
      list.push(f)
      byBudget.set(b, list)
    }
    for (const [budget, list] of byBudget) {
      for (let i = 0; i < list.length; i += IMAGE_GROUP) {
        if (this.aborted || !(await this.waitPower(big))) return false
        const batch = list.slice(i, i + IMAGE_GROUP)
        const hashes = batch.map((f) => hashImage(f.path, budget))
        const ask = batch.map((f, k) => ({ f, hash: hashes[k] })).filter((x) => x.hash && !hasVector.get(x.hash))
        const seen = new Set<string>()
        const unique = ask.filter((x) => !seen.has(hex(x.hash!)) && (seen.add(hex(x.hash!)), true))
        const result = unique.length ? await this.startEmbedder(true).embedImages(unique.map((x) => x.f.path), budget) : { vectors: [], errors: [] }
        if (this.aborted) return false
        const errors = new Map<string, string>()
        store.transaction(() => {
          unique.forEach((x, k) => {
            const v = result.vectors[k]
            if (v) insertVector.run(x.hash!, packVector(v, 0, v.length))
            else errors.set(hex(x.hash!), result.errors[k] ?? "failed")
          })
          batch.forEach((f, k) => {
            const hash = hashes[k]
            const note = !hash ? "unreadable" : errors.get(hex(hash))
            const rows = hash && !note ? [{ n: 0, hash, start: -1, end: -1 }] : []
            this.storeFile(store, { file: f, total: 1, to: 1, rows, waiting: new Set(), note })
            stats.files.add(f.id)
          })
        })()
        this.progress.embedded += unique.length - errors.size
        this.progress.reused += batch.length - unique.length
        this.progress.done += batch.length
        this.progress.current = batch.at(-1)!.path
        this.emit()
        this.opts.onCommit?.()
      }
    }
    return true
  }
}
