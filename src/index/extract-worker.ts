/** Worker entry: runs extraction jobs off the indexer thread. */
import type { ExtractOptions } from "./extract/index.ts"
import { type ExtractJob, JOBS_AT_ONCE, processJob, replyBuffers } from "./extract-job.ts"
import { backgroundDisk } from "./load.ts"
import type { ExtractWorkerIn } from "./pool.ts"

import { observeProcesses } from "../util/process.ts"

declare const self: Worker
observeProcesses((pid, running) => postMessage({ process: pid, running }))

let opts: ExtractOptions
/** Jobs not started yet, taken on in order (the pool relies on it when a worker crashes). */
const queue: ExtractJob[] = []
let head = 0
let running = 0

function pump() {
  while (running < JOBS_AT_ONCE && head < queue.length) {
    const job = queue[head++]!
    if (head === queue.length) {
      queue.length = 0
      head = 0
    }
    running++
    postMessage({ started: job.id })
    processJob(job, opts).then((reply) => {
      running--
      if (reply.status === "ok") postMessage(reply, replyBuffers(reply))
      else postMessage(reply)
      pump()
    })
  }
}

self.onmessage = (ev: MessageEvent<ExtractWorkerIn>) => {
  const msg = ev.data
  if ("opts" in msg) {
    opts = msg.opts
    if (msg.backgroundDisk) backgroundDisk()
  }
  else {
    for (const job of msg.jobs) queue.push(job)
    pump()
  }
}
