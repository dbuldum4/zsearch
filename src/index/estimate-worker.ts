/** Worker entry that estimates first passes (see `estimateInBackground`). */
import type { Config } from "../config.ts"
import { estimateFolders } from "./estimate.ts"

declare const self: Worker

self.onmessage = (ev: MessageEvent<{ roots: string[]; config: Config }>) => {
  try {
    postMessage({ estimates: estimateFolders(ev.data.roots, ev.data.config) })
  } catch (err) {
    postMessage({ error: (err as Error).message })
  }
}
