import type { Config } from "../config.ts"
import type { SearchDiagnosis } from "./diagnose.ts"
import type { Preview, RelatedResponse, SearchResponse } from "./engine.ts"
import type { SearchIn, SearchOut, StatsWithSemantic } from "./protocol.ts"
import type { Mode } from "./query.ts"
import type { ReadOptions, ReadResult } from "./read.ts"
import { workerUrl } from "../util/workers.ts"

export interface StatsReply {
  stats: StatsWithSemantic
}

/**
 * Talks to the search worker. Only the newest search/preview request resolves with data;
 * superseded ones resolve with null. A watchdog restarts the worker if a pathological
 * regex keeps it busy for too long.
 */
export class SearchClient {
  private worker!: Worker
  private qid = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; kind: string; started: number }>()
  /** Sent requests stay timed even when a newer request supersedes their caller. */
  private outstanding = new Map<number, { kind: string; started: number }>()
  private ready!: Promise<void>
  private readyResolve!: () => void
  /** Resolves when the worker is ready or could not open the index. */
  private settled!: Promise<void>
  private settle!: () => void
  private started = false
  /** Why the worker could not open the index, and when: requests get this error, not a timeout. */
  private failed: { error: string; at: number } | null = null
  private watchdog: ReturnType<typeof setInterval>
  onRefreshed?: (files: number, changed: boolean) => void
  onRestart?: (reason: string) => void

  constructor(
    private dbPath: string,
    private config: Config,
    private timeoutMs = 20_000,
  ) {
    this.spawn()
    this.watchdog = setInterval(() => this.checkStuck(), Math.max(10, Math.min(1000, this.timeoutMs / 2)))
    ;(this.watchdog as { unref?: () => void }).unref?.()
  }

  private spawn() {
    this.started = false
    this.failed = null
    this.ready = new Promise((r) => (this.readyResolve = r))
    this.settled = new Promise((r) => (this.settle = r))
    this.worker = new Worker(workerUrl("search/search-worker.ts"))
    this.worker.onmessage = (ev: MessageEvent<SearchOut>) => this.handle(ev.data)
    this.worker.onerror = (ev) => {
      ev.preventDefault?.()
      this.restart(`search worker crashed: ${(ev as ErrorEvent).message}`)
    }
    this.post({ type: "init", dbPath: this.dbPath, config: this.config })
    if (this.semanticKept) this.post({ type: "keepSemantic" })
  }

  private semanticKept = false

  /**
   * Have the query model running and the vectors loaded before semantic searches, from a quiet
   * second after start-up on, rather than start them on the first and stop them when idle.
   */
  keepSemanticReady() {
    this.semanticKept = true
    this.post({ type: "keepSemantic" })
  }

  private restart(reason: string) {
    this.worker.terminate()
    this.failPending(reason)
    this.onRestart?.(reason)
    this.spawn()
  }

  private failPending(reason: string) {
    this.outstanding.clear()
    for (const [qid, p] of this.pending) {
      p.resolve(p.kind === "search" ? ({ error: reason } as never) : null)
      this.pending.delete(qid)
    }
  }

  private checkStuck() {
    const now = Date.now()
    for (const p of [...this.outstanding.values(), ...this.pending.values()]) {
      if (now - p.started > this.timeoutMs) {
        this.restart(`${p.kind} took longer than ${this.timeoutMs / 1000}s and was stopped`)
        return
      }
    }
  }

  private post(m: SearchIn) {
    this.worker.postMessage(m)
  }

  private handle(m: SearchOut) {
    switch (m.type) {
      case "completed":
        this.outstanding.delete(m.qid)
        break
      case "ready":
        this.started = true
        this.readyResolve()
        this.settle()
        break
      case "related":
      case "results":
      case "diagnosis":
      case "preview":
      case "previews":
      case "stats":
      case "read": {
        const p = this.pending.get(m.qid)
        if (!p) break
        this.pending.delete(m.qid)
        p.resolve(m.type === "results" || m.type === "related" ? m.response : m.type === "diagnosis" ? { diagnosis: m.diagnosis } : m.type === "preview" ? m.preview : m.type === "previews" ? m.previews : m.type === "read" ? { result: m.result, error: m.error } : { stats: m.stats })
        break
      }
      case "refreshed":
        this.onRefreshed?.(m.files, m.changed)
        break
      case "error": {
        if (m.qid === undefined) {
          // Only "init" has no qid: the worker could not open the index.
          if (!this.started) {
            this.failed = { error: `could not open the index: ${m.error}`, at: Date.now() }
            this.worker.terminate()
            this.failPending(this.failed.error)
            this.settle()
          }
          break
        }
        const p = this.pending.get(m.qid)
        if (!p) break
        this.pending.delete(m.qid)
        p.resolve(p.kind === "search" ? ({ error: m.error } as never) : null)
        break
      }
    }
  }

  private request<T>(kind: string, build: (qid: number) => SearchIn, signal?: AbortSignal): Promise<T | null> {
    if (signal?.aborted) return Promise.resolve(null)
    if (this.failed) {
      // Try opening it again now and then (it may have been rebuilt), not on every keystroke.
      if (Date.now() - this.failed.at < 2000) return Promise.resolve(kind === "search" ? ({ error: this.failed.error } as T) : null)
      this.spawn()
    }
    if (kind === "search") this.cancelRelated()
    const qid = ++this.qid
    // Supersede older requests of the same kind. A search supersedes explanations as well: the
    // worker drops them (see search-worker.ts).
    for (const [id, p] of this.pending) {
      if (p.kind === kind || ((kind === "search" || kind === "related") && (p.kind === "explain" || p.kind === "search"))) {
        p.resolve(null)
        this.pending.delete(id)
      }
    }
    const abort = () => this.cancelRelated(qid)
    signal?.addEventListener("abort", abort, { once: true })
    return new Promise<T | null>((resolve) => {
      this.pending.set(qid, { resolve: resolve as (v: unknown) => void, kind, started: Date.now() })
      const worker = this.worker
      void this.ready.then(() => {
        if (this.worker !== worker || !this.pending.has(qid)) return
        this.outstanding.set(qid, { kind, started: Date.now() })
        this.post(build(qid))
      })
    }).finally(() => signal?.removeEventListener("abort", abort))
  }

  /** Until the worker is ready, or could not open the index (requests then say why). */
  async waitReady() {
    await this.settled
  }

  /** `explain`: explain an empty result before replying (see `explain` for searches while typing). */
  search(query: string, mode: Mode, limit = 200, explain = true, groupDuplicates = false): Promise<SearchResponse | null> {
    return this.request<SearchResponse>("search", (qid) => ({ type: "search", qid, query, mode, limit, explain, groupDuplicates }))
  }

  related(source: number | string, limit = 20, signal?: AbortSignal): Promise<RelatedResponse | null> {
    return this.request<RelatedResponse>("related", (qid) => ({ type: "related", qid, source, limit }), signal)
  }

  cancelRelated(request?: number) {
    for (const [id, p] of this.pending) if (p.kind === "related" && (request === undefined || id === request)) { p.resolve(null); this.pending.delete(id) }
    this.post({ type: "cancelRelated", request })
  }

  /**
   * Why `query` finds nothing (`diagnosis` is left out when it finds something, or there is nothing
   * to say). Null when superseded by a newer explanation or search.
   */
  explain(query: string, mode: Mode, limit = 200): Promise<{ diagnosis?: SearchDiagnosis } | null> {
    return this.request<{ diagnosis?: SearchDiagnosis }>("explain", (qid) => ({ type: "explain", qid, query, mode, limit }))
  }

  preview(id: number, query: string, mode: Mode, focusLine?: number): Promise<Preview | null> {
    return this.request<Preview>("preview", (qid) => ({ type: "preview", qid, id, query, mode, focusLine }))
  }

  /**
   * Previews of several files at once (prefetching). A newer batch supersedes an older one.
   * `focusLines[i]`, when set, is the line to show for `ids[i]` (its search hit's first line).
   */
  previews(ids: number[], query: string, mode: Mode, focusLines?: (number | null)[]): Promise<Preview[] | null> {
    return this.request<Preview[]>("previews", (qid) => ({ type: "previews", qid, ids, query, mode, focusLines }))
  }

  /** A file's text by line range (see read.ts); `result` is null when the file is not in the index, or with `error`. */
  read(path: string, query: string, mode: Mode, opts: ReadOptions): Promise<{ result: ReadResult | null; error?: string } | null> {
    return this.request<{ result: ReadResult | null; error?: string }>("read", (qid) => ({ type: "read", qid, path, query, mode, opts }))
  }

  stats(): Promise<StatsReply | null> {
    return this.request<StatsReply>("stats", (qid) => ({ type: "stats", qid }))
  }

  refresh(force = false) {
    void this.ready.then(() => this.post({ type: "refresh", force }))
  }

  setConfig(config: Config) {
    this.config = config
    void this.ready.then(() => this.post({ type: "config", config }))
  }

  opened(path: string) {
    void this.ready.then(() => this.post({ type: "opened", path }))
  }

  close() {
    clearInterval(this.watchdog)
    this.worker.terminate()
  }
}
