/** Cuts files into passages for the Granite indexer. */
import { cutFile } from "./cut.ts"
import type { SemanticWorkerIn, SemanticWorkerOut } from "./workers.ts"

declare const self: Worker
self.onmessage = (ev: MessageEvent<SemanticWorkerIn>) => {
  const msg = ev.data
  try {
    postMessage({ id: msg.id, cuts: msg.cut.map(cutFile) } satisfies SemanticWorkerOut)
  } catch (err) {
    postMessage({ id: msg.id, error: (err as Error).message } satisfies SemanticWorkerOut)
  }
}
