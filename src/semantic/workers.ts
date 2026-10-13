/** Worker threads cut files into passages while Granite embeds the preceding group. */
import { workerUrl } from "../util/workers.ts"
import type { Cut, CutJob } from "./cut.ts"

export type SemanticWorkerIn = { id: number; cut: CutJob[] }
export type SemanticWorkerOut = { id: number; cuts: Cut[] } | { id: number; error: string }

type Reply = Exclude<SemanticWorkerOut, { error: string }>

/** Texts a worker is sent at least, when there are fewer than that for each: a message costs something too. */
const MIN_RUN = 8

export class SemanticWorkers {
  private workers: Worker[] = []
  private next = 0
  private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>()
  private dead: string | null = null

  constructor(threads: number) {
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
      this.workers.push(w)
    }
  }

  private fail(message: string) {
    this.dead ??= message
    for (const p of this.pending.values()) p.reject(new Error(message))
    this.pending.clear()
    this.close()
  }

  private send<T extends Reply>(w: Worker, msg: { cut: CutJob[] }): Promise<T> {
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

  close() {
    for (const w of this.workers) w.terminate()
    this.workers = []
  }

  kill() {
    this.fail("the semantic workers were stopped")
  }
}
