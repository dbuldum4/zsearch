import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A tiny, deterministic model2vec model: every word belongs to a topic and its vector
 * points along that topic's axis (plus a little per-word noise). Good enough to verify
 * that "meaning" search finds documents that share no words with the query.
 */
export const TOPICS: Record<string, string[]> = {
  finance: ["budget", "revenue", "money", "invoice", "finance", "spending", "cost", "costs", "expenses", "profit", "salary", "tax", "funding", "quarterly"],
  cooking: ["recipe", "pancakes", "flour", "eggs", "milk", "butter", "salt", "fry", "cook", "cooking", "breakfast", "kitchen", "golden", "bake"],
  space: ["rocket", "probe", "telemetry", "mission", "orbit", "launch", "nasa", "spacecraft", "downlink", "thermal", "vacuum", "astronaut", "satellite"],
  travel: ["trip", "passport", "lisbon", "flight", "hotel", "vacation", "journey", "travel", "airport", "visa", "renew"],
  nature: ["hiking", "alps", "glacier", "mountain", "climate", "forest", "river", "photosynthesis", "chlorophyll", "plants", "light", "carbon", "nature"],
  code: ["server", "function", "return", "import", "port", "http", "request", "config", "json", "parse", "bun", "serve", "code"],
}

const SPECIAL = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"]
const FILLER = ["the", "a", "of", "to", "and", "in", "for", "is", "on", "with", "about", "my", "how", "do", "i", "what", "find", "documents", "##s", "##ing", "##ed"]

function rand(seed: number) {
  let x = seed
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    return x / 0x7fffffff - 0.5
  }
}

export function writeTestModel(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const topicNames = Object.keys(TOPICS)
  const dims = topicNames.length + 2
  const vocab: string[] = [...SPECIAL, ...FILLER]
  const topicOf = new Map<string, number>()
  topicNames.forEach((t, i) => {
    for (const w of TOPICS[t]!) {
      if (!vocab.includes(w)) vocab.push(w)
      topicOf.set(w, i)
    }
  })
  const r = rand(7)
  const emb = new Float32Array(vocab.length * dims)
  vocab.forEach((w, id) => {
    const t = topicOf.get(w)
    for (let d = 0; d < dims; d++) emb[id * dims + d] = r() * 0.1
    if (t !== undefined) emb[id * dims + t] = 1
    else emb[id * dims + dims - 1] = 0.3 // filler words: weak shared direction
  })
  // safetensors
  const header = JSON.stringify({ embeddings: { dtype: "F32", shape: [vocab.length, dims], data_offsets: [0, emb.byteLength] } })
  const padded = header + " ".repeat((8 - ((header.length + 8) % 8)) % 8)
  const buf = new Uint8Array(8 + padded.length + emb.byteLength)
  new DataView(buf.buffer).setBigUint64(0, BigInt(padded.length), true)
  buf.set(new TextEncoder().encode(padded), 8)
  buf.set(new Uint8Array(emb.buffer), 8 + padded.length)
  writeFileSync(join(dir, "model.safetensors"), buf)
  const vocabObj: Record<string, number> = {}
  vocab.forEach((w, i) => (vocabObj[w] = i))
  writeFileSync(
    join(dir, "tokenizer.json"),
    JSON.stringify({
      version: "1.0",
      truncation: null,
      padding: null,
      added_tokens: SPECIAL.map((content, id) => ({ id, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true })),
      normalizer: { type: "BertNormalizer", clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true },
      pre_tokenizer: { type: "BertPreTokenizer" },
      post_processor: null,
      decoder: { type: "WordPiece", prefix: "##", cleanup: true },
      model: { type: "WordPiece", unk_token: "[UNK]", continuing_subword_prefix: "##", max_input_chars_per_word: 100, vocab: vocabObj },
    }),
  )
  writeFileSync(join(dir, "config.json"), JSON.stringify({ model_type: "model2vec", architectures: ["StaticModel"], hidden_dim: dims, normalize: true }))
  return dir
}
