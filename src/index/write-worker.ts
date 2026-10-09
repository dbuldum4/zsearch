/** Worker entry: writes extracted contents to the index (see ThreadSink). */
import { type ContentWriter, openWriter, type WriteWorkerIn, type WriteWorkerOut } from "./writer.ts"

declare const self: Worker

let writer: ContentWriter | null = null
let failed = false
const send = (m: WriteWorkerOut) => postMessage(m)

self.onmessage = (ev: MessageEvent<WriteWorkerIn>) => {
  const msg = ev.data
  if (failed) return
  try {
    if (msg.type === "open") writer = openWriter(msg.path)
    else if (msg.type === "write") {
      writer!.write(msg.items, msg.fresh)
      send({ type: "written", bytes: msg.bytes })
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
