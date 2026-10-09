/** Worker entry that runs one indexing pass and streams progress to the parent. */
import type { Config } from "../config.ts"
import { clearIndex, openDb } from "./db.ts"
import { Indexer, type IndexProgress } from "./indexer.ts"
import { acquireLock } from "./lock.ts"

declare const self: Worker

export type IndexWorkerIn = { type: "start"; config: Config; dbPath: string; lockPath: string; rebuild?: boolean } | { type: "cancel" }

export type IndexWorkerOut =
  | { type: "progress"; progress: IndexProgress }
  | { type: "commit" }
  | { type: "done"; progress: IndexProgress }
  | { type: "locked" }
  | { type: "fatal"; error: string }

const controller = new AbortController()
const send = (m: IndexWorkerOut) => postMessage(m)

self.onmessage = async (ev: MessageEvent<IndexWorkerIn>) => {
  const msg = ev.data
  if (msg.type === "cancel") {
    controller.abort()
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
    const indexer = new Indexer(db, msg.config, {
      signal: controller.signal,
      onProgress: (progress) => send({ type: "progress", progress }),
      onCommit: () => {
        const now = Date.now()
        if (now - lastCommit < 200) return
        lastCommit = now
        send({ type: "commit" })
      },
    })
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
