import type { Database } from "bun:sqlite"
import { type Config, paths } from "../../src/config.ts"
import { indexStats, openDb } from "../../src/index/db.ts"
import { Indexer } from "../../src/index/indexer.ts"
import type { StatsReply } from "../../src/search/client.ts"
import { SearchEngine } from "../../src/search/engine.ts"
import type { IndexHandle, SearchService, Services } from "../../src/tui/services.ts"

/** Services backed by in-process engines, recording side effects for assertions. */
export function testServices(config: Config, opts: { firstRun?: boolean; dbPath?: string } = {}) {
  const dbPath = opts.dbPath ?? paths().db
  const db: Database = openDb(dbPath)
  let engine = new SearchEngine(db, config)
  const calls = { open: [] as string[], reveal: [] as string[], edit: [] as { path: string; line?: number }[], copy: [] as string[], saved: [] as Config[], indexRuns: 0 }
  const search: SearchService = {
    async search(query, mode, limit) {
      return engine.search(query, mode, { limit })
    },
    async preview(id, query, mode, focusLine) {
      return engine.preview(id, query, mode, focusLine)
    },
    async stats(): Promise<StatsReply> {
      return { stats: indexStats(db, dbPath) }
    },
    refresh(force) {
      const changed = engine.refresh(force)
      queueMicrotask(() => search.onRefreshed?.(engine.catalog.size, changed))
    },
    setConfig(c) {
      engine.config = c
    },
    opened(path) {
      engine.recordOpen(path)
    },
    close() {},
  }
  const services: Services = {
    paths: paths(),
    config,
    firstRun: opts.firstRun ?? false,
    search,
    saveConfig: (c) => calls.saved.push(structuredClone(c)),
    startIndex(c, handlers): IndexHandle {
      calls.indexRuns++
      const controller = new AbortController()
      const indexer = new Indexer(db, c, { inProcess: true, signal: controller.signal, onProgress: handlers.onProgress, onCommit: handlers.onCommit })
      const done = indexer.run().then((progress) => ({ status: progress.phase === "done" ? ("done" as const) : progress.phase === "cancelled" ? ("cancelled" as const) : ("error" as const), progress }))
      return { done, cancel: () => controller.abort() }
    },
    indexLockedBy: () => null,
    async open(path) {
      calls.open.push(path)
      return null
    },
    async reveal(path) {
      calls.reveal.push(path)
      return null
    },
    async edit(path, line) {
      calls.edit.push({ path, line })
      return null
    },
    async copy(text) {
      calls.copy.push(text)
      return "host"
    },
  }
  return {
    services,
    calls,
    db,
    resetEngine: () => (engine = new SearchEngine(db, config)),
    close: () => db.close(),
  }
}
