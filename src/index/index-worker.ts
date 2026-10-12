/** Worker entry that runs one indexing pass and streams progress to the parent. */
import { type Config, configExists, loadConfig } from "../config.ts"
import { clearIndex, openDb } from "./db.ts"
import { Indexer, type IndexProgress } from "./indexer.ts"
import { acquireLock } from "./lock.ts"
import { PowerGate } from "./power.ts"
import { embedToolPath } from "../semantic/helper.ts"
import { SemanticIndexer, semanticAvailable } from "../semantic/indexer.ts"

declare const self: Worker

export type IndexWorkerIn = { type: "start"; config: Config; dbPath: string; lockPath: string; rebuild?: boolean; background?: boolean } | { type: "cancel" } | { type: "goNow" }

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
    const result = await indexer.run()
    // Then search by meaning: embed what the run read, under the same cancel, power and priority rules.
    const tool = embedToolPath()
    if (result.phase === "done" && !semanticAvailable(msg.config, tool)) {
      const started = Date.now()
      const base = result.elapsedMs
      const semantic = new SemanticIndexer(db, msg.config, tool, {
        signal: controller.signal,
        power,
        goNow: () => goNow,
        low: msg.background || undefined,
        onCommit,
        onProgress: (p) => send({ type: "progress", progress: { ...result, phase: "meaning", current: p.current, waiting: p.waiting, elapsedMs: base + Date.now() - started, meaning: { total: p.total, done: p.done, embedded: p.embedded, reused: p.reused } } }),
      })
      const summary = await semantic.run()
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
