/** Worker entry: writes extracted contents to the index, or checkpoints its log (see ThreadSink). */
import type { Database } from "bun:sqlite"
import { openDb } from "./db.ts"
import { backgroundDisk } from "./load.ts"
import { type ContentWriter, openWriter, type WriteWorkerIn, type WriteWorkerOut } from "./writer.ts"

declare const self: Worker

let writer: ContentWriter | null = null
let checkpointDb: Database | null = null
let failed = false
const send = (m: WriteWorkerOut) => postMessage(m)

self.onmessage = (ev: MessageEvent<WriteWorkerIn>) => {
  const msg = ev.data
  if (failed) return
  if (msg.type === "open" && msg.backgroundDisk) backgroundDisk()
  if (msg.type === "checkpoint" || (msg.type === "open" && msg.role === "checkpointer")) {
    try {
      if (msg.type === "open") checkpointDb = openDb(msg.path)
      // Passive: copies what is committed, without holding up the writer.
      else checkpointDb?.exec("PRAGMA wal_checkpoint(PASSIVE)")
    } catch {
      // busy or failed: the next one, or the writer's own, does it
    }
    if (msg.type === "checkpoint" && msg.last) {
      try {
        checkpointDb?.close(true)
      } catch {
        // the thread ends anyway
      }
      checkpointDb = null
      send({ type: "checkpointed" })
    }
    return
  }
  try {
    if (msg.type === "open") writer = openWriter(msg.path)
    else if (msg.type === "write") {
      writer!.write(msg.items, msg.fresh ? [msg.fresh] : [])
      send({ type: "written", bytes: msg.bytes })
    } else if (msg.type === "close") {
      writer!.close()
      writer = null
      send({ type: "closed" })
    } else {
      writer!.commit()
      send({ type: "committed" })
    }
  } catch (err) {
    // Stop at the first failure: what is not committed is rolled back when the thread ends.
    failed = true
    try {
      writer?.rollback()
    } catch {
      // the connection is closed with the thread anyway
    }
    send({ type: "error", error: (err as Error).message })
  }
}
