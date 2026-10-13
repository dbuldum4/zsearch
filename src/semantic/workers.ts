/**
 * The semantic pass's worker threads (`semantic-worker.ts`). They cut files into passages for
 * both passes and, for Potion's, embed them too: cutting, hashing and embedding a passage is about
 * a tenth of a millisecond of work, which on the indexer's thread alone held the pass to about
 * 1,500 passages a second. That thread is left to check which passages are new and store them.
 *
 * Potion's table is read once, into memory the workers share; each has its own tokenizer. A batch
 * is cut into one run per worker, of about as much text each.
 */
import { workerUrl } from "../util/workers.ts"
import type { Cut, CutJob } from "./cut.ts"
import type { TextEmbedder } from "./helper.ts"
import { type PotionTables, readTables } from "./potion.ts"

/** `into`: memory shared with the indexer, where the texts' vectors go from `at` (in floats) on. */
export type SemanticWorkerIn = { tables: PotionTables; tokenizer: string; slot: number } | { id: number; cut: CutJob[] } | { id: number; texts: string[]; into: Float32Array; at: number }
export type SemanticWorkerOut = { id: number; cuts: Cut[] } | { id: number; tokens: number } | { id: number; error: string }

type Reply = Exclude<SemanticWorkerOut, { error: string }>

/** Texts a worker is sent at least, when there are fewer than that for each: a message costs something too. */
const MIN_RUN = 8

export class SemanticWorkers implements TextEmbedder {
  private workers: Worker[] = []
  private next = 0
  private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>()
  private dead: string | null = null
  /** Potion's vector size, when the workers have it. */
  readonly dim: number = 0

  constructor(threads: number, potion?: { model: string; tokenizer: string }) {
    const tables = potion ? readTables(potion.model, Math.max(1, threads)) : null
    if (tables) this.dim = tables.dim
    for (let i = 0; i < Math.max(1, threads); i++) {
      const w = new Worker(workerUrl("semantic/semantic-worker.ts"))
      w.onmessage = (ev: MessageEvent<SemanticWorkerOut>) => {
        const r = ev.data
        const p = this.pending.get(r.id)
        if (!p) return
        this.pending.delete(r.id)
        if ("error" in r) p.reject(new Error(r.error))
        else p.resolve(r)
      }
      w.onerror = (ev) => this.fail((ev as ErrorEvent).message || "a semantic worker crashed")
      if (tables) w.postMessage({ tables, tokenizer: potion!.tokenizer, slot: i } satisfies SemanticWorkerIn)
      this.workers.push(w)
    }
  }

  private fail(message: string) {
    this.dead ??= message
    for (const p of this.pending.values()) p.reject(new Error(message))
    this.pending.clear()
    this.close()
  }

  private send<T extends Reply>(w: Worker, msg: { cut: CutJob[] } | { texts: string[]; into: Float32Array; at: number }): Promise<T> {
    if (this.dead) return Promise.reject(new Error(this.dead))
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: Reply) => void, reject })
      w.postMessage({ id, ...msg } as SemanticWorkerIn)
    })
  }

  /** Where to cut `sizes` into runs of about the same total, one per worker at most. */
  private runs(sizes: number[]): number[] {
    const n = Math.max(1, Math.min(this.workers.length, Math.ceil(sizes.length / MIN_RUN)))
    let total = 0
    for (const s of sizes) total += s
    const cuts = [0]
    let sum = 0
    for (let i = 0; i < sizes.length && cuts.length < n; i++) {
      sum += sizes[i]!
      if (sum >= (total * cuts.length) / n) cuts.push(i + 1)
    }
    cuts.push(sizes.length)
    return cuts
  }

  /** Each file's passages, in order. */
  async cut(jobs: CutJob[]): Promise<Cut[]> {
    const cuts = this.runs(jobs.map((j) => j.data.length))
    const parts = await Promise.all(cuts.slice(0, -1).map((from, k) => this.send<{ id: number; cuts: Cut[] }>(this.workers[k]!, { cut: jobs.slice(from, cuts[k + 1]) })))
    return parts.flatMap((p) => p.cuts)
  }

  async embedTexts(texts: string[]): Promise<{ vectors: Float32Array; dim: number; tokens: number }> {
    const dim = this.dim
    if (!dim) throw new Error("the semantic workers have no model")
    const cuts = this.runs(texts.map((t) => t.length))
    // The workers write the vectors where the indexer reads them: copying them out of the
    // workers' replies took as long as all the rest of the indexer's work.
    const vectors = new Float32Array(new SharedArrayBuffer(texts.length * dim * 4))
    const parts = await Promise.all(cuts.slice(0, -1).map((from, k) => this.send<{ id: number; tokens: number }>(this.workers[k]!, { texts: texts.slice(from, cuts[k + 1]), into: vectors, at: from * dim })))
    return { vectors, dim, tokens: parts.reduce((t, p) => t + p.tokens, 0) }
  }

  close() {
    for (const w of this.workers) w.terminate()
    this.workers = []
  }

  kill() {
    this.fail("the semantic workers were stopped")
  }
}
