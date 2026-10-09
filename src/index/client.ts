import type { Config } from "../config.ts"
import type { IndexWorkerIn, IndexWorkerOut } from "./index-worker.ts"
import type { IndexProgress } from "./indexer.ts"
import { workerUrl } from "../util/workers.ts"

export interface IndexRunHandlers {
  onProgress?: (p: IndexProgress) => void
  onCommit?: () => void
}

export type IndexOutcome = { status: "done" | "cancelled" | "error"; progress: IndexProgress } | { status: "locked" } | { status: "fatal"; error: string }

/** Runs one indexing pass in a worker thread. */
export class IndexRun {
  private worker: Worker
  readonly done: Promise<IndexOutcome>

  constructor(config: Config, dbPath: string, lockPath: string, handlers: IndexRunHandlers = {}) {
    this.worker = new Worker(workerUrl("index/index-worker.ts"))
    this.done = new Promise<IndexOutcome>((resolve) => {
      this.worker.onmessage = (ev: MessageEvent<IndexWorkerOut>) => {
        const m = ev.data
        switch (m.type) {
          case "progress":
            handlers.onProgress?.(m.progress)
            break
          case "commit":
            handlers.onCommit?.()
            break
          case "done":
            handlers.onProgress?.(m.progress)
            resolve({ status: m.progress.phase === "done" ? "done" : m.progress.phase === "cancelled" ? "cancelled" : "error", progress: m.progress })
            this.worker.terminate()
            break
          case "locked":
            resolve({ status: "locked" })
            this.worker.terminate()
            break
          case "fatal":
            resolve({ status: "fatal", error: m.error })
            this.worker.terminate()
            break
        }
      }
      this.worker.onerror = (ev) => {
        ev.preventDefault?.()
        resolve({ status: "fatal", error: (ev as ErrorEvent).message || "indexer crashed" })
        this.worker.terminate()
      }
    })
    const msg: IndexWorkerIn = { type: "start", config, dbPath, lockPath }
    this.worker.postMessage(msg)
  }

  cancel() {
    const msg: IndexWorkerIn = { type: "cancel" }
    this.worker.postMessage(msg)
  }

  kill() {
    this.worker.terminate()
  }
}
