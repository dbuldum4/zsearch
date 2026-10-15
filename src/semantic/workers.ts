/** A worker thread cuts files into passages while Granite embeds the preceding group. */
import { workerUrl } from "../util/workers.ts"
import type { Cut, CutJob } from "./cut.ts"

export type SemanticWorkerIn = { id: number; cut: CutJob[] }
export type SemanticWorkerOut = { id: number; cuts: Cut[] } | { id: number; error: string }

/** One thread: the helper takes the cores, and cutting is a small part of the pass. */
export class CutWorker {
  private worker: Worker | null
  private next = 0
  private pending = new Map<number, { resolve: (cuts: Cut[]) => void; reject: (e: Error) => void }>()
  private dead: string | null = null

  constructor() {
    const w = new Worker(workerUrl("semantic/semantic-worker.ts"))
    w.onmessage = (ev: MessageEvent<SemanticWorkerOut>) => {
      const r = ev.data
      const p = this.pending.get(r.id)
      if (!p) return
      this.pending.delete(r.id)
      if ("error" in r) p.reject(new Error(r.error))
      else p.resolve(r.cuts)
    }
    w.onerror = (ev) => this.fail((ev as ErrorEvent).message || "the semantic worker crashed")
    this.worker = w
  }

  private fail(message: string) {
    this.dead ??= message
    for (const p of this.pending.values()) p.reject(new Error(message))
    this.pending.clear()
    this.close()
  }

  /** Each file's passages, in order. */
  cut(jobs: CutJob[]): Promise<Cut[]> {
    const w = this.worker
    if (this.dead || !w) return Promise.reject(new Error(this.dead ?? "the semantic worker was closed"))
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      w.postMessage({ id, cut: jobs } satisfies SemanticWorkerIn)
    })
  }

  close() {
    this.worker?.terminate()
    this.worker = null
  }

  kill() {
    this.fail("the semantic worker was stopped")
  }
}
