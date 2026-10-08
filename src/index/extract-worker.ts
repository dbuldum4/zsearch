/** Worker entry: runs extraction jobs off the indexer thread. */
import type { ExtractOptions } from "./extract/index.ts"
import { type ExtractJob, processJob } from "./extract-job.ts"

declare const self: Worker

self.onmessage = async (ev: MessageEvent<{ job: ExtractJob; opts: ExtractOptions }>) => {
  const reply = await processJob(ev.data.job, ev.data.opts)
  if (reply.status === "ok") postMessage(reply, [reply.compressed.buffer as ArrayBuffer])
  else postMessage(reply)
}
