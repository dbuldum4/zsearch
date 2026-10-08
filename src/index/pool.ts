import { cpus } from "node:os"
import type { ExtractOptions } from "./extract/index.ts"
import { type ExtractJob, type ExtractReply, processJob } from "./extract-job.ts"
import { workerUrl } from "../util/workers.ts"

/** A small pool of extraction workers with at most `perWorker` jobs in flight each. */
export class ExtractPool {
  private workers: Worker[] = []
  private inflight = new Map<Worker, number>()
  private waiting = new Map<number, (r: ExtractReply) => void>()
  private owner = new Map<number, Worker>()
  private jobs = new Map<number, ExtractJob>()
  private idleResolvers: (() => void)[] = []
  readonly size: number

  constructor(
    size: number,
    private opts: ExtractOptions,
    private perWorker = 2,
    private inProcess = false,
  ) {
    this.size = Math.max(1, size)
    if (inProcess) return
    for (let i = 0; i < this.size; i++) this.spawn()
  }

  static defaultSize(): number {
    return Math.max(1, Math.min(8, cpus().length - 1))
  }

  private spawn(): Worker {
    const w = new Worker(workerUrl("index/extract-worker.ts"))
    w.onmessage = (ev: MessageEvent<ExtractReply>) => this.finish(w, ev.data)
    w.onerror = (ev) => {
      // A crashed worker (e.g. out of memory on a pathological file) fails its jobs and is replaced.
      ev.preventDefault?.()
      this.replace(w, (ev as ErrorEvent).message || "extraction worker crashed")
    }
    this.workers.push(w)
    this.inflight.set(w, 0)
    return w
  }

  private replace(w: Worker, error: string) {
    for (const [id, owner] of [...this.owner]) {
      if (owner === w) this.finish(w, { id, status: "error", error })
    }
    w.terminate()
    this.workers = this.workers.filter((x) => x !== w)
    this.inflight.delete(w)
    this.spawn()
  }

  private finish(w: Worker | null, reply: ExtractReply) {
    const cb = this.waiting.get(reply.id)
    if (!cb) return
    this.waiting.delete(reply.id)
    this.owner.delete(reply.id)
    this.jobs.delete(reply.id)
    if (w) this.inflight.set(w, Math.max(0, (this.inflight.get(w) ?? 1) - 1))
    cb(reply)
    if (this.waiting.size === 0) for (const r of this.idleResolvers.splice(0)) r()
  }

  /** Free capacity across all workers. */
  get capacity(): number {
    if (this.inProcess) return this.size - this.waiting.size
    let free = 0
    for (const n of this.inflight.values()) free += Math.max(0, this.perWorker - n)
    return free
  }

  get pending(): number {
    return this.waiting.size
  }

  run(job: ExtractJob): Promise<ExtractReply> {
    return new Promise((resolve) => {
      this.waiting.set(job.id, resolve)
      this.jobs.set(job.id, job)
      if (this.inProcess) {
        processJob(job, this.opts).then((r) => this.finish(null, r))
        return
      }
      let best = this.workers[0]!
      for (const w of this.workers) if ((this.inflight.get(w) ?? 0) < (this.inflight.get(best) ?? 0)) best = w
      this.inflight.set(best, (this.inflight.get(best) ?? 0) + 1)
      this.owner.set(job.id, best)
      best.postMessage({ job, opts: this.opts })
    })
  }

  idle(): Promise<void> {
    if (this.waiting.size === 0) return Promise.resolve()
    return new Promise((r) => this.idleResolvers.push(r))
  }

  close() {
    for (const w of this.workers) w.terminate()
    this.workers = []
    for (const id of [...this.waiting.keys()]) this.finish(null, { id, status: "error", error: "cancelled" })
  }
}
