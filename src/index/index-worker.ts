/** Worker entry that runs one indexing pass and streams progress to the parent. */
import { type Config, configExists, loadConfig } from "../config.ts"
import { clearIndex, openDb } from "./db.ts"
import { Indexer, type IndexProgress } from "./indexer.ts"
import { acquireLock } from "./lock.ts"
import { PowerGate } from "./power.ts"

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
    // Big runs that started on their own wait on power. The settings are read again with the
    // power state: switching pausing off resumes a run.
    const indexer = new Indexer(db, msg.config, {
      signal: controller.signal,
      power: msg.background ? new PowerGate(() => (configExists() ? loadConfig() : msg.config)) : undefined,
      onProgress: (progress) => send({ type: "progress", progress }),
      onCommit: () => {
        const now = Date.now()
        if (now - lastCommit < 200) return
        lastCommit = now
        send({ type: "commit" })
      },
    })
    running = indexer
    if (goNow) indexer.goNow()
    const result = await indexer.run()
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
