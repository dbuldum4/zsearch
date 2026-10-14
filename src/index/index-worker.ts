/** Worker entry that runs one indexing pass and streams progress to the parent. */
import type { Database } from "bun:sqlite"
import { type Config, configExists, loadConfig, resolvePath } from "../config.ts"
import { clearIndex, getMeta, openDb } from "./db.ts"
import { Indexer, type IndexProgress } from "./indexer.ts"
import { acquireLock } from "./lock.ts"
import { PowerGate } from "./power.ts"
import { embedToolPath } from "../semantic/helper.ts"
import { runSemanticPass, semanticAvailable } from "../semantic/indexer.ts"

declare const self: Worker

export type IndexWorkerIn = { type: "start"; config: Config; dbPath: string; lockPath: string; rebuild?: boolean; background?: boolean; meaningOnly?: boolean } | { type: "cancel" } | { type: "goNow" }

export type IndexWorkerOut =
  | { type: "progress"; progress: IndexProgress }
  | { type: "commit" }
  | { type: "done"; progress: IndexProgress }
  | { type: "locked" }
  | { type: "fatal"; error: string }

const controller = new AbortController()
let running: Indexer | null = null
/** Asked to go now before the indexer existed. */
let goNow = false
const send = (m: IndexWorkerOut) => postMessage(m)

self.onmessage = async (ev: MessageEvent<IndexWorkerIn>) => {
  const msg = ev.data
  if (msg.type === "cancel") {
    controller.abort()
    return
  }
  if (msg.type === "goNow") {
    goNow = true
    running?.goNow()
    return
  }
  const release = acquireLock(msg.lockPath)
  if (!release) {
    send({ type: "locked" })
    return
  }
  try {
    const db = openDb(msg.dbPath)
    if (msg.rebuild) clearIndex(db)
    let lastCommit = 0
    const onCommit = () => {
      const now = Date.now()
      if (now - lastCommit < 200) return
      lastCommit = now
      send({ type: "commit" })
    }
    // Big runs that started on their own wait on power. The settings are read again with the
    // power state: switching pausing off resumes a run.
    const power = msg.background ? new PowerGate(() => (configExists() ? loadConfig() : msg.config)) : undefined
    const indexer = new Indexer(db, msg.config, {
      signal: controller.signal,
      power,
      onProgress: (progress) => send({ type: "progress", progress }),
      onCommit,
    })
    running = indexer
    if (goNow) indexer.goNow()
    // A meaning-only run skips the scan and word content pass: it embeds the text earlier
    // runs already extracted, so testing semantic search never re-reads files for word search.
    // Folders no full run has read yet have no text to embed: those are read first.
    const startedAt = Date.now()
    let result: IndexProgress = { phase: "done", scanned: 0, added: 0, updated: 0, removed: 0, contentTotal: 0, contentDone: 0, contentBytes: 0, contentErrors: 0, current: "", startedAt, elapsedMs: 0 }
    const tool = embedToolPath()
    const blocked = semanticAvailable(msg.config, tool)
    if (!msg.meaningOnly || (!blocked && unreadRoots(db, msg.config))) result = await indexer.run()
    // Then semantic search: embed what the run read, under the same cancel, power and priority rules.
    if (msg.meaningOnly && blocked) {
      result.phase = "error"
      result.error = `semantic search cannot run: ${blocked}`
      result.elapsedMs = Date.now() - startedAt
    } else if (result.phase === "done" && !blocked) {
      const started = Date.now()
      const base = result.elapsedMs
      const summary = await runSemanticPass(db, msg.config, tool, {
        signal: controller.signal,
        power,
        goNow: () => goNow,
        low: msg.background || undefined,
        onCommit,
        onProgress: (p) => send({ type: "progress", progress: { ...result, phase: "meaning", current: p.current, waiting: p.waiting, elapsedMs: base + Date.now() - started, meaning: { total: p.total, done: p.done, embedded: p.embedded, reused: p.reused } } }),
      })
      result.elapsedMs = base + Date.now() - started
      result.meaning = { total: summary.files, done: summary.files, embedded: summary.embedded, reused: summary.reused, error: summary.error }
      if (summary.status === "cancelled") result.phase = "cancelled"
    }
    db.close()
    // Release before reporting: the parent terminates this worker as soon as it hears "done",
    // which could otherwise leave the lock behind and refuse the next run.
    release()
    send({ type: "commit" })
    send({ type: "done", progress: result })
  } catch (err) {
    release()
    send({ type: "fatal", error: (err as Error).message })
  } finally {
    release()
  }
}

/** Whether a configured folder has never been read by a finished full run. */
function unreadRoots(db: Database, config: Config): boolean {
  const read = new Set<string>(JSON.parse(getMeta(db, "roots") ?? "[]"))
  return config.roots.some((root) => !read.has(resolvePath(root)))
}
