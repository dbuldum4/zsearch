/** Worker entry for `SemanticWorkers`: cuts files into passages, and embeds them with Potion when it has the model. */
import { cutFile } from "./cut.ts"
import { PotionModel, readTokenizer } from "./potion.ts"
import type { SemanticWorkerIn, SemanticWorkerOut } from "./workers.ts"

declare const self: Worker
let model: PotionModel | null = null

self.onmessage = (ev: MessageEvent<SemanticWorkerIn>) => {
  const msg = ev.data
  if ("tables" in msg) {
    model = PotionModel.fromTables(readTokenizer(msg.tokenizer), msg.tables, msg.slot)
    return
  }
  try {
    if ("cut" in msg) {
      postMessage({ id: msg.id, cuts: msg.cut.map(cutFile) } satisfies SemanticWorkerOut)
      return
    }
    if (!model) throw new Error("this worker has no model")
    const dim = model.dim
    let tokens = 0
    for (let i = 0; i < msg.texts.length; i++) tokens += model.embedInto(msg.texts[i]!, msg.into.subarray(msg.at + i * dim, msg.at + (i + 1) * dim))
    postMessage({ id: msg.id, tokens } satisfies SemanticWorkerOut)
  } catch (err) {
    postMessage({ id: msg.id, error: (err as Error).message } satisfies SemanticWorkerOut)
  }
}
