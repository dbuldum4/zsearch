import type { ExtractOptions } from "./extract/index.ts"
import { type ExtractJob, type ExtractReply, JOBS_AT_ONCE, processJob } from "./extract-job.ts"
import { workerUrl } from "../util/workers.ts"
import { DOCUMENT_EXTS, OCR_EXTS } from "../kinds.ts"

/** Messages to an extraction worker: its options once, then batches of jobs. */
export type ExtractWorkerIn = { opts: ExtractOptions; backgroundDisk: boolean } | { jobs: ExtractJob[] }

/**
 * A small pool of extraction workers with at most `perWorker` jobs queued each. Jobs go out in
 * batches: a message costs about as much as the extraction of a small text file. A worker with a
 * document queued takes only as many jobs as it runs at once: a document can take seconds, and
 * the jobs queued behind it could not go to another worker.
 */
export class ExtractPool {
  private workers: Worker[] = []
  /** Each worker's unfinished jobs, in the order it takes them on. */
  private assigned = new Map<Worker, Map<number, ExtractJob>>()
  private waiting = new Map<number, (r: ExtractReply) => void>()
  private owner = new Map<number, Worker>()
  private outbox = new Map<Worker, ExtractJob[]>()
  /** Documents among each worker's unfinished jobs. */
  private docs = new Map<Worker, number>()
  /** The worker documents of each type go to while it has room: their parsers warm up once. */
  private affinity = new Map<string, Worker>()
  private flushQueued = false
  private idleResolvers: (() => void)[] = []
  /** Workers in the pool. */
  size: number

  constructor(
    size: number,
    private opts: ExtractOptions,
    private perWorker = 2,
    private inProcess = false,
    /** The workers read files at a low disk priority (see `backgroundDisk`). */
    private backgroundDisk = false,
  ) {
    this.size = Math.max(1, size)
    if (inProcess) return
    for (let i = 0; i < this.size; i++) this.spawn()
  }

  /** Add workers, up to `size` in all. */
  grow(size: number) {
    while (this.size < size) {
      this.size++
      if (!this.inProcess) this.spawn()
    }
  }

  private spawn(): Worker {
    const w = new Worker(workerUrl("index/extract-worker.ts"))
    w.onmessage = (ev: MessageEvent<ExtractReply>) => this.finish(w, ev.data)
    w.onerror = (ev) => {
      // A crashed worker (e.g. out of memory on a pathological file) fails its jobs and is replaced.
      ev.preventDefault?.()
      this.replace(w, (ev as ErrorEvent).message || "extraction worker crashed")
    }
    const init: ExtractWorkerIn = { opts: this.opts, backgroundDisk: this.backgroundDisk }
    w.postMessage(init)
    this.workers.push(w)
    this.assigned.set(w, new Map())
    this.docs.set(w, 0)
    return w
  }

  private replace(w: Worker, error: string) {
    const jobs = [...(this.assigned.get(w)?.values() ?? [])]
    w.terminate()
    this.workers = this.workers.filter((x) => x !== w)
    this.assigned.delete(w)
    this.docs.delete(w)
    for (const [ext, x] of this.affinity) if (x === w) this.affinity.delete(ext)
    this.outbox.delete(w)
    this.spawn()
    // The worker takes its jobs on in order, a few at a time: the first ones were running and
    // fail. The others had not started, and go to the workers left.
    for (const [k, job] of jobs.entries()) {
      if (k < JOBS_AT_ONCE) this.finish(null, { id: job.id, status: "error", error })
      else this.send(job)
    }
  }

  private finish(w: Worker | null, reply: ExtractReply) {
    const owner = this.owner.get(reply.id)
    // A late reply from a worker the job was taken from.
    if (w && owner !== w) return
    const cb = this.waiting.get(reply.id)
    if (!cb) return
    this.waiting.delete(reply.id)
    this.owner.delete(reply.id)
    if (owner) {
      const job = this.assigned.get(owner)?.get(reply.id)
      if (job && slow(job.ext)) this.docs.set(owner, this.docs.get(owner)! - 1)
      this.assigned.get(owner)?.delete(reply.id)
    }
    cb(reply)
    if (this.waiting.size === 0) for (const r of this.idleResolvers.splice(0)) r()
  }

  /** Jobs a worker takes. */
  private limit(w: Worker): number {
    return this.docs.get(w) ? Math.min(this.perWorker, JOBS_AT_ONCE) : this.perWorker
  }

  private free(w: Worker): number {
    return Math.max(0, this.limit(w) - this.assigned.get(w)!.size)
  }

  /** Jobs the pool takes at once, as things stand. */
  get slots(): number {
    if (this.inProcess) return this.size
    let n = 0
    for (const w of this.workers) n += this.limit(w)
    return n
  }

  /** Free capacity across all workers. */
  get capacity(): number {
    if (this.inProcess) return this.size - this.waiting.size
    let free = 0
    for (const w of this.workers) free += this.free(w)
    return free
  }

  get pending(): number {
    return this.waiting.size
  }

  run(job: ExtractJob): Promise<ExtractReply> {
    return new Promise((resolve) => {
      this.waiting.set(job.id, resolve)
      if (this.inProcess) processJob(job, this.opts).then((r) => this.finish(null, r))
      else this.send(job)
    })
  }

  /**
   * Queue a job on the least busy worker with room, or a document on the worker that took the
   * last of its type if that one has room. What is queued in one turn of the event loop goes out
   * together.
   */
  private send(job: ExtractJob) {
    const load = (w: Worker) => this.assigned.get(w)!.size + (this.free(w) ? 0 : 1 << 20)
    let best = this.workers[0]!
    for (const w of this.workers) if (load(w) < load(best)) best = w
    const doc = slow(job.ext)
    if (doc) {
      const w = this.affinity.get(job.ext)
      if (w && this.free(w)) best = w
      else this.affinity.set(job.ext, best)
      this.docs.set(best, this.docs.get(best)! + 1)
    }
    this.assigned.get(best)!.set(job.id, job)
    this.owner.set(job.id, best)
    const box = this.outbox.get(best)
    if (box) box.push(job)
    else this.outbox.set(best, [job])
    if (!this.flushQueued) {
      this.flushQueued = true
      queueMicrotask(() => this.flush())
    }
  }

  /** Send what is queued now, rather than at the end of the current task. */
  flush() {
    this.flushQueued = false
    for (const [w, jobs] of this.outbox) {
      const msg: ExtractWorkerIn = { jobs }
      w.postMessage(msg)
    }
    this.outbox.clear()
  }

  idle(): Promise<void> {
    if (this.waiting.size === 0) return Promise.resolve()
    return new Promise((r) => this.idleResolvers.push(r))
  }

  close() {
    for (const w of this.workers) w.terminate()
    this.workers = []
    this.assigned.clear()
    this.docs.clear()
    this.outbox.clear()
    for (const id of [...this.waiting.keys()]) this.finish(null, { id, status: "error", error: "cancelled" })
  }
}

/** Documents and images (read with OCR) can take seconds each, against microseconds for text. */
function slow(ext: string): boolean {
  return DOCUMENT_EXTS.has(ext) || OCR_EXTS.has(ext)
}
