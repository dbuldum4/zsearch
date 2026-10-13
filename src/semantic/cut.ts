/**
 * A file's passages for one round of a semantic pass: its stored text cut (`chunk.ts`), the
 * passages with words, the text each goes to the model as, and its hash. It is the most of what
 * the pass does for each passage after embedding it, so it runs in workers (`semantic-worker.ts`).
 */
import { createHash } from "node:crypto"
import { decompressText } from "../index/db.ts"
import { chunkText, documentPrompt, hasWords, titleOf } from "./chunk.ts"

export interface CutJob {
  /** The file's stored text, as the main index keeps it (compressed). */
  data: Uint8Array
  name: string
  /** Passages read already, and how many to read up to. */
  from: number
  cap: number
}

export interface CutPassage {
  n: number
  start: number
  end: number
  prompt: string
  hash: Uint8Array
}

export interface Cut {
  /** All the file's passages, and up to which this round reads. */
  total: number
  to: number
  /** This round's passages with words. */
  passages: CutPassage[]
}

/** A passage's identity: a hash of exactly what the model reads. */
export function hashText(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s).digest().subarray(0, 16))
}

export function cutFile(job: CutJob): Cut {
  const chunks = chunkText(decompressText(job.data))
  const to = Math.min(chunks.length, Math.max(job.from, job.cap))
  const title = titleOf(job.name)
  const passages: CutPassage[] = []
  for (let n = job.from; n < to; n++) {
    const c = chunks[n]!
    if (!hasWords(c.text)) continue
    const prompt = documentPrompt(title, c.text)
    passages.push({ n, start: c.start, end: c.end, prompt, hash: hashText(prompt) })
  }
  return { total: chunks.length, to, passages }
}
