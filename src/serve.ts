/**
 * `zsearch serve`: the search engine without a terminal UI, for the macOS app.
 *
 * Requests arrive on stdin and replies and events leave on stdout, one JSON object per line.
 * A request may carry a numeric `id`; its reply carries the same `id`. Search and preview
 * requests supersede older ones of the same type, which then reply `cancelled`.
 * The server exits when stdin closes.
 */
import { createInterface } from "node:readline"
import { type Config, configExists, defaultConfig, ensureDirs, loadConfig, mergeConfig, saveConfig } from "./config.ts"
import type { IndexStats } from "./index/db.ts"
import { IndexRun } from "./index/client.ts"
import type { IndexProgress } from "./index/indexer.ts"
import { lockHolder } from "./index/lock.ts"
import { SearchClient } from "./search/client.ts"
import type { Preview, SearchResponse } from "./search/engine.ts"
import { MODES, type Mode } from "./search/query.ts"

export type ServeIn =
  | { id?: number; type: "search"; query: string; mode?: Mode; limit?: number }
  | { id?: number; type: "preview"; file: number; query: string; mode?: Mode; focusLine?: number }
  | { id?: number; type: "previews"; files: number[]; query: string; mode?: Mode }
  | { id?: number; type: "stats" }
  | { id?: number; type: "config" }
  | { id?: number; type: "setConfig"; config: Partial<Config> }
  | { id?: number; type: "index"; rebuild?: boolean }
  | { id?: number; type: "cancelIndex" }
  | { id?: number; type: "opened"; path: string }

export type ServeOut =
  | { type: "ready"; version: string; files: number; firstRun: boolean; config: Config }
  | { id?: number; type: "results"; response: SearchResponse }
  | { id?: number; type: "preview"; preview: Preview }
  | { id?: number; type: "previews"; previews: Preview[] }
  | { id?: number; type: "stats"; stats: IndexStats }
  | { id?: number; type: "config"; config: Config }
  | { id?: number; type: "cancelled" }
  | { id?: number; type: "ok" }
  | { id?: number; type: "error"; error: string }
  | { type: "indexProgress"; progress: IndexProgress }
  | { type: "indexDone"; status: "done" | "cancelled" | "error" | "locked"; progress?: IndexProgress; error?: string }
  | { type: "refreshed"; files: number; changed: boolean }

/** Progress events are throttled to this interval; the last one before `indexDone` always goes out. */
const PROGRESS_MS = 100

export async function serve(version: string): Promise<number> {
  const p = ensureDirs()
  const firstRun = !configExists()
  let config = loadConfig()
  const client = new SearchClient(p.db, config)
  let index: IndexRun | null = null

  const send = (m: ServeOut): void => void process.stdout.write(JSON.stringify(m) + "\n")
  const mode = (m: unknown): Mode => (MODES.includes(m as Mode) ? (m as Mode) : config.defaultMode)

  client.onRefreshed = (files, changed) => send({ type: "refreshed", files, changed })
  client.onRestart = (reason) => send({ type: "error", error: reason })

  const startIndex = (id?: number, rebuild = false) => {
    if (index) return send({ id, type: "error", error: "indexing is already running" })
    const other = lockHolder(p.lock)
    if (other !== null) return send({ id, type: "error", error: `another zsearch process (pid ${other}) is updating the index` })
    let last = 0
    let pending: IndexProgress | null = null
    const run = new IndexRun(config, p.db, p.lock, {
      onProgress: (progress) => {
        pending = progress
        const now = Date.now()
        if (now - last < PROGRESS_MS) return
        last = now
        pending = null
        send({ type: "indexProgress", progress })
      },
      onCommit: () => client.refresh(),
    }, rebuild)
    index = run
    send({ id, type: "ok" })
    void run.done.then((outcome) => {
      index = null
      if (pending) send({ type: "indexProgress", progress: pending })
      client.refresh(true)
      if (outcome.status === "fatal") send({ type: "indexDone", status: "error", error: outcome.error })
      else if (outcome.status === "locked") send({ type: "indexDone", status: "locked" })
      else send({ type: "indexDone", status: outcome.status, progress: outcome.progress, error: outcome.progress.error })
    })
  }

  const handle = async (msg: ServeIn) => {
    const id = typeof msg.id === "number" ? msg.id : undefined
    switch (msg.type) {
      case "search": {
        const response = await client.search(String(msg.query ?? ""), mode(msg.mode), msg.limit ?? 200)
        return send(response ? { id, type: "results", response } : { id, type: "cancelled" })
      }
      case "preview": {
        const preview = await client.preview(msg.file, String(msg.query ?? ""), mode(msg.mode), msg.focusLine)
        return send(preview ? { id, type: "preview", preview } : { id, type: "cancelled" })
      }
      case "previews": {
        const files = Array.isArray(msg.files) ? msg.files.filter((f) => typeof f === "number").slice(0, 32) : []
        const previews = await client.previews(files, String(msg.query ?? ""), mode(msg.mode))
        return send(previews ? { id, type: "previews", previews } : { id, type: "cancelled" })
      }
      case "stats": {
        const reply = await client.stats()
        return send(reply ? { id, type: "stats", stats: reply.stats } : { id, type: "cancelled" })
      }
      case "config":
        return send({ id, type: "config", config })
      case "setConfig": {
        config = mergeConfig(defaultConfig(), msg.config)
        saveConfig(config)
        client.setConfig(config)
        return send({ id, type: "config", config })
      }
      case "index":
        return startIndex(id, msg.rebuild === true)
      case "cancelIndex":
        index?.cancel()
        return send({ id, type: "ok" })
      case "opened":
        client.opened(String(msg.path))
        return send({ id, type: "ok" })
      default:
        return send({ id, type: "error", error: `unknown request type "${(msg as { type?: unknown }).type}"` })
    }
  }

  await client.waitReady()
  const stats = await client.stats()
  send({ type: "ready", version, files: stats?.stats.files ?? 0, firstRun, config })

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const inflight = new Set<Promise<void>>()
  for await (const line of lines) {
    if (!line.trim()) continue
    let msg: ServeIn
    try {
      msg = JSON.parse(line)
      if (typeof msg !== "object" || msg === null) throw new Error("expected a JSON object")
    } catch (e) {
      send({ type: "error", error: `bad request: ${(e as Error).message}` })
      continue
    }
    const task = handle(msg).catch((e) => send({ id: msg.id, type: "error", error: (e as Error).message }))
    inflight.add(task)
    void task.finally(() => inflight.delete(task))
  }
  // stdin closed: finish what was asked, stop indexing cleanly, and exit.
  await Promise.all(inflight)
  if (index) {
    const run: IndexRun = index
    run.cancel()
    await Promise.race([run.done, new Promise((r) => setTimeout(r, 5000))])
    run.kill()
  }
  client.close()
  return 0
}
