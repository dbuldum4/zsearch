import type { Config } from "../config.ts"
import type { IndexStats } from "../index/db.ts"
import type { Preview, SearchResponse } from "./engine.ts"
import type { SearchIn, SearchOut } from "./protocol.ts"
import type { Mode } from "./query.ts"
import { workerUrl } from "../util/workers.ts"

export interface StatsReply {
  stats: IndexStats
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
  private ready!: Promise<void>
  private readyResolve!: () => void
  private watchdog: ReturnType<typeof setInterval>
  onRefreshed?: (files: number, changed: boolean) => void
  onRestart?: (reason: string) => void

  constructor(
    private dbPath: string,
    private config: Config,
    private timeoutMs = 20_000,
  ) {
    this.spawn()
    this.watchdog = setInterval(() => this.checkStuck(), 1000)
    ;(this.watchdog as { unref?: () => void }).unref?.()
  }

  private spawn() {
    this.ready = new Promise((r) => (this.readyResolve = r))
    this.worker = new Worker(workerUrl("search/search-worker.ts"))
    this.worker.onmessage = (ev: MessageEvent<SearchOut>) => this.handle(ev.data)
    this.worker.onerror = (ev) => {
      ev.preventDefault?.()
      this.restart(`search worker crashed: ${(ev as ErrorEvent).message}`)
    }
    this.post({ type: "init", dbPath: this.dbPath, config: this.config })
  }

  private restart(reason: string) {
    this.worker.terminate()
    for (const [qid, p] of this.pending) {
      if (p.kind === "search") p.resolve({ error: reason } as never)
      else p.resolve(null)
      this.pending.delete(qid)
    }
    this.onRestart?.(reason)
    this.spawn()
  }

  private checkStuck() {
    const now = Date.now()
    for (const p of this.pending.values()) {
      if (p.kind === "search" && now - p.started > this.timeoutMs) {
        this.restart(`search took longer than ${this.timeoutMs / 1000}s and was stopped`)
        return
      }
    }
  }

  private post(m: SearchIn) {
    this.worker.postMessage(m)
  }

  private handle(m: SearchOut) {
    switch (m.type) {
      case "ready":
        this.readyResolve()
        break
      case "results":
      case "preview":
      case "previews":
      case "stats": {
        const p = this.pending.get(m.qid)
        if (!p) break
        this.pending.delete(m.qid)
        p.resolve(m.type === "results" ? m.response : m.type === "preview" ? m.preview : m.type === "previews" ? m.previews : { stats: m.stats })
        break
      }
      case "refreshed":
        this.onRefreshed?.(m.files, m.changed)
        break
      case "error": {
        if (m.qid === undefined) break
        const p = this.pending.get(m.qid)
        if (!p) break
        this.pending.delete(m.qid)
        p.resolve(p.kind === "search" ? ({ error: m.error } as never) : null)
        break
      }
    }
  }

  private request<T>(kind: string, build: (qid: number) => SearchIn): Promise<T | null> {
    const qid = ++this.qid
    // Supersede older requests of the same kind.
    for (const [id, p] of this.pending) {
      if (p.kind === kind) {
        p.resolve(null)
        this.pending.delete(id)
      }
    }
    return new Promise<T | null>((resolve) => {
      this.pending.set(qid, { resolve: resolve as (v: unknown) => void, kind, started: Date.now() })
      void this.ready.then(() => this.post(build(qid)))
    })
  }

  async waitReady() {
    await this.ready
  }

  search(query: string, mode: Mode, limit = 200): Promise<SearchResponse | null> {
    return this.request<SearchResponse>("search", (qid) => ({ type: "search", qid, query, mode, limit }))
  }

  preview(id: number, query: string, mode: Mode, focusLine?: number): Promise<Preview | null> {
    return this.request<Preview>("preview", (qid) => ({ type: "preview", qid, id, query, mode, focusLine }))
  }

  /** Previews of several files at once (prefetching). A newer batch supersedes an older one. */
  previews(ids: number[], query: string, mode: Mode): Promise<Preview[] | null> {
    return this.request<Preview[]>("previews", (qid) => ({ type: "previews", qid, ids, query, mode }))
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
