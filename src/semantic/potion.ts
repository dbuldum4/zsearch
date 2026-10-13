/**
 * potion-retrieval-32M (Model2Vec, MIT, https://github.com/MinishLab/model2vec), run in-process:
 * the text is cut into BERT word pieces with the model's own vocabulary (`tokenizer.json`), and
 * its vector is the average of their rows in the embedding table (`model.safetensors`), as
 * Model2Vec's `StaticModel.encode` makes it: no special tokens, unknown pieces left out, the first
 * 512 pieces, then L2-normalized. No network runs, so a passage takes microseconds.
 */
import { readFileSync } from "node:fs"
import type { TextEmbedder } from "./helper.ts"

/** Word pieces read of one text, at most (Model2Vec's default `max_length`). */
const MAX_TOKENS = 512
/** Characters of a word, at most, before it counts as unknown (the tokenizer's `max_input_chars_per_word`). */
const MAX_WORD_CHARS = 100

/** Model2Vec's pieces: a lowercased, accent-free BERT WordPiece tokenizer. */
export class WordPiece {
  private vocab: Map<string, number>
  readonly unk: number | undefined

  constructor(vocab: Record<string, number>, private prefix = "##") {
    this.vocab = new Map(Object.entries(vocab))
    this.unk = this.vocab.get("[UNK]")
  }

  static fromJson(json: { model?: { type?: string; vocab?: Record<string, number>; continuing_subword_prefix?: string } }): WordPiece {
    if (json.model?.type !== "WordPiece" || !json.model.vocab) throw new Error("the Potion tokenizer is not a WordPiece tokenizer")
    return new WordPiece(json.model.vocab, json.model.continuing_subword_prefix ?? "##")
  }

  /** The text's pieces, without special or unknown ones, at most `max`. */
  encode(text: string, max = MAX_TOKENS): number[] {
    const out: number[] = []
    for (const word of preTokenize(normalize(text))) {
      for (const id of this.word(word)) {
        if (id === this.unk) continue
        out.push(id)
        if (out.length >= max) return out
      }
    }
    return out
  }

  /** Greedy longest-match WordPiece: the whole word is unknown when any part of it is. */
  private word(word: string): number[] {
    const chars = [...word]
    if (chars.length > MAX_WORD_CHARS) return this.unk === undefined ? [] : [this.unk]
    const ids: number[] = []
    let start = 0
    while (start < chars.length) {
      let end = chars.length
      let found: number | undefined
      while (start < end) {
        const piece = (start > 0 ? this.prefix : "") + chars.slice(start, end).join("")
        found = this.vocab.get(piece)
        if (found !== undefined) break
        end--
      }
      if (found === undefined) return this.unk === undefined ? [] : [this.unk]
      ids.push(found)
      start = end
    }
    return ids
  }
}

/** BertNormalizer: control characters out, whitespace as spaces, spaces around CJK, lowercase, no accents. */
export function normalize(text: string): string {
  // Most text needs only the last step.
  if (!/[^\x20-\x7e\n]/.test(text)) return text.replace(/\n/g, " ").toLowerCase()
  let out = ""
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp === 0 || cp === 0xfffd) continue
    if (ch === "\t" || ch === "\n" || ch === "\r" || /\s/u.test(ch)) { out += " "; continue }
    if (/[\p{Cc}\p{Cf}]/u.test(ch)) continue
    out += isCjk(cp) ? ` ${ch} ` : ch
  }
  return out.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "")
}

function isCjk(cp: number): boolean {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f)
}

/** BertPreTokenizer: words split at whitespace, and every punctuation mark a word of its own. */
export function preTokenize(text: string): string[] {
  return text.match(/[!-/:-@\[-`{-~]|\p{P}|[^\s!-/:-@\[-`{-~\p{P}]+/gu) ?? []
}

interface Tensor {
  dtype: string
  shape: number[]
  data_offsets: [number, number]
}

/** The tensors of a safetensors file, as 32-bit floats (or integers, for `mapping`). */
function readSafetensors(path: string): Map<string, { shape: number[]; values: Float32Array | Int32Array }> {
  const buf = readFileSync(path)
  const headerLen = Number(buf.readBigUInt64LE(0))
  const header = JSON.parse(buf.toString("utf8", 8, 8 + headerLen)) as Record<string, Tensor>
  const base = 8 + headerLen
  const out = new Map<string, { shape: number[]; values: Float32Array | Int32Array }>()
  for (const [name, t] of Object.entries(header)) {
    if (name === "__metadata__") continue
    // Copied: the data needn't be aligned for its type.
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset + base + t.data_offsets[0], t.data_offsets[1] - t.data_offsets[0]).slice()
    let values: Float32Array | Int32Array
    if (t.dtype === "F32") values = new Float32Array(bytes.buffer)
    else if (t.dtype === "F16") values = Float32Array.from(new Float16Array(bytes.buffer))
    else if (t.dtype === "BF16") {
      const u16 = new Uint16Array(bytes.buffer)
      const u32 = new Uint32Array(u16.length)
      for (let i = 0; i < u16.length; i++) u32[i] = u16[i]! << 16
      values = new Float32Array(u32.buffer)
    } else if (t.dtype === "I32") values = new Int32Array(bytes.buffer)
    else if (t.dtype === "I64") values = Int32Array.from(new BigInt64Array(bytes.buffer), Number)
    else throw new Error(`the Potion model has a tensor of an unknown type (${t.dtype})`)
    out.set(name, { shape: t.shape, values })
  }
  return out
}

/** The model in memory: its tokenizer and its table of vectors (32-bit floats: 16-bit ones are 4x slower to add up here). */
export class PotionModel {
  private constructor(
    readonly tokenizer: WordPiece,
    readonly dim: number,
    private table: Float32Array,
    /** Model2Vec's optional token weights and token-to-row mapping. */
    private weights: Float32Array | null,
    private mapping: Int32Array | null,
  ) {}

  /** From the model's files: `model.safetensors` and `tokenizer.json`. */
  static load(model: string, tokenizer: string): PotionModel {
    const tensors = readSafetensors(model)
    const emb = tensors.get("embeddings") ?? [...tensors.values()].find((t) => t.shape.length === 2)
    if (!emb || emb.shape.length !== 2 || !(emb.values instanceof Float32Array)) throw new Error("the Potion model has no embedding table")
    const weights = tensors.get("weights")?.values
    const mapping = tensors.get("mapping")?.values
    return new PotionModel(
      WordPiece.fromJson(JSON.parse(readFileSync(tokenizer, "utf8"))),
      emb.shape[1]!,
      emb.values,
      weights instanceof Float32Array ? weights : null,
      mapping instanceof Int32Array ? mapping : null,
    )
  }

  /** For tests: a model of these vectors and this vocabulary. */
  static of(vocab: Record<string, number>, rows: number[][]): PotionModel {
    return new PotionModel(new WordPiece(vocab), rows[0]!.length, Float32Array.from(rows.flat()), null, null)
  }

  /** The text's L2-normalized vector into `out` (zeros when it has no known pieces); returns its pieces. */
  embedInto(text: string, out: Float32Array): number {
    out.fill(0)
    const ids = this.tokenizer.encode(text)
    const dim = this.dim
    const rows = this.table.length / dim
    for (const id of ids) {
      const row = this.mapping ? this.mapping[id]! : id
      if (row < 0 || row >= rows) continue
      const w = this.weights ? this.weights[id]! : 1
      const base = row * dim
      for (let d = 0; d < dim; d++) out[d]! += this.table[base + d]! * w
    }
    let n = 0
    for (let d = 0; d < dim; d++) n += out[d]! * out[d]!
    if (n > 0) {
      const s = 1 / Math.sqrt(n)
      for (let d = 0; d < dim; d++) out[d]! *= s
    }
    return ids.length
  }
}

/** Potion as an embedder, alike to the helper's (`helper.ts`) for the indexer and search. */
export class PotionEmbedder implements TextEmbedder {
  constructor(private model: PotionModel) {}

  async embedTexts(texts: string[]): Promise<{ vectors: Float32Array; dim: number; tokens: number }> {
    const dim = this.model.dim
    const vectors = new Float32Array(texts.length * dim)
    let tokens = 0
    texts.forEach((t, i) => { tokens += this.model.embedInto(t, vectors.subarray(i * dim, (i + 1) * dim)) })
    return { vectors, dim, tokens }
  }

  close() {}
  kill() {}
}
