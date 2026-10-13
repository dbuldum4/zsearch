/**
 * potion-retrieval-32M (Model2Vec, MIT, https://github.com/MinishLab/model2vec), run in-process:
 * the text is cut into BERT word pieces with the model's own vocabulary (`tokenizer.json`), and
 * its vector is the average of their rows in the embedding table (`model.safetensors`), as
 * Model2Vec's `StaticModel.encode` makes it: no special tokens, unknown pieces left out, the first
 * 512 pieces, then L2-normalized. No network runs, so a passage takes microseconds.
 */
import { closeSync, openSync, readFileSync, readSync } from "node:fs"
import type { TextEmbedder } from "./helper.ts"

/** Word pieces read of one text, at most (Model2Vec's default `max_length`). */
const MAX_TOKENS = 512
/** Characters of a word, at most, before it counts as unknown (the tokenizer's `max_input_chars_per_word`). */
const MAX_WORD_CHARS = 100
/** Words whose pieces are kept, at most: about 20 MB. */
const WORD_CACHE = 200_000

/** Model2Vec's pieces: a lowercased, accent-free BERT WordPiece tokenizer. */
export class WordPiece {
  private vocab: Map<string, number>
  /** Pieces of the words seen so far. */
  private cache = new Map<string, number[]>()
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
    if (PLAIN.test(text)) return this.encodePlain(text, max, out)
    for (const word of preTokenize(normalize(text))) {
      for (const id of this.word(word)) {
        if (id === this.unk) continue
        out.push(id)
        if (out.length >= max) return out
      }
    }
    return out
  }

  /**
   * `encode` of printable ASCII, as most text is, in one pass: what `normalize` does to it is
   * lowercase it, and `preTokenize` cuts it at spaces and at each punctuation mark.
   */
  private encodePlain(text: string, max: number, out: number[]): number[] {
    const s = text.toLowerCase()
    const push = (word: string) => {
      for (const id of this.word(word)) {
        if (id === this.unk) continue
        out.push(id)
        if (out.length >= max) return true
      }
      return false
    }
    let start = -1
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c === 32 || c === 10) {
        if (start >= 0 && push(s.slice(start, i))) return out
        start = -1
      } else if (c <= 47 || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || c >= 123) {
        if (start >= 0 && push(s.slice(start, i))) return out
        start = -1
        if (push(s[i]!)) return out
      } else if (start < 0) start = i
    }
    if (start >= 0) push(s.slice(start))
    return out
  }

  /** Greedy longest-match WordPiece: the whole word is unknown when any part of it is. */
  private word(word: string): number[] {
    const cached = this.cache.get(word)
    if (cached) return cached
    const ids = this.split(word)
    // Words repeat (Zipf): most are looked up once and then found here.
    if (this.cache.size >= WORD_CACHE) this.cache.clear()
    this.cache.set(word, ids)
    return ids
  }

  private split(word: string): number[] {
    // Pieces are cut at code points: a word with none outside the BMP is cut at UTF-16 units.
    const chars = /[\ud800-\udfff]/.test(word) ? [...word] : null
    const length = chars ? chars.length : word.length
    const unknown = this.unk === undefined ? [] : [this.unk]
    if (length > MAX_WORD_CHARS) return unknown
    const ids: number[] = []
    let start = 0
    while (start < length) {
      let end = length
      let found: number | undefined
      while (start < end) {
        const text = chars ? chars.slice(start, end).join("") : word.slice(start, end)
        found = this.vocab.get(start > 0 ? this.prefix + text : text)
        if (found !== undefined) break
        end--
      }
      if (found === undefined) return unknown
      ids.push(found)
      start = end
    }
    return ids
  }
}

/** Text `normalize` only lowercases (and turns line breaks into spaces). */
const PLAIN = /^[\x20-\x7e\n]*$/

/** BertNormalizer: control characters out, whitespace as spaces, spaces around CJK, lowercase, no accents. */
export function normalize(text: string): string {
  // Most text needs only the last step.
  if (PLAIN.test(text)) return text.replace(/\n/g, " ").toLowerCase()
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

/**
 * The tensors of a safetensors file, as 32-bit floats (or integers, for `mapping`). `place`
 * gives the memory to read a tensor of 32-bit floats into, when it has one for it.
 */
function readSafetensors(path: string, place: (name: string, t: Tensor) => Uint8Array | null = () => null): Map<string, { shape: number[]; values: Float32Array | Int32Array }> {
  const fd = openSync(path, "r")
  try {
    const read = (bytes: Uint8Array, at: number) => {
      for (let n = 0; n < bytes.length;) {
        const got = readSync(fd, bytes, n, bytes.length - n, at + n)
        if (!got) throw new Error("the Potion model file is cut short")
        n += got
      }
      return bytes
    }
    const len = read(new Uint8Array(8), 0)
    const headerLen = Number(new DataView(len.buffer).getBigUint64(0, true))
    const header = JSON.parse(new TextDecoder().decode(read(new Uint8Array(headerLen), 8))) as Record<string, Tensor>
    const base = 8 + headerLen
    const out = new Map<string, { shape: number[]; values: Float32Array | Int32Array }>()
    for (const [name, t] of Object.entries(header)) {
      if (name === "__metadata__") continue
      const size = t.data_offsets[1] - t.data_offsets[0]
      // Read into memory of its own: the data needn't be aligned for its type in the file.
      const bytes = read((t.dtype === "F32" ? place(name, t) : null) ?? new Uint8Array(size), base + t.data_offsets[0])
      const at = bytes.byteOffset
      let values: Float32Array | Int32Array
      if (t.dtype === "F32") values = new Float32Array(bytes.buffer, at, size / 4)
      else if (t.dtype === "F16") values = Float32Array.from(new Float16Array(bytes.buffer, at, size / 2))
      else if (t.dtype === "BF16") {
        const u16 = new Uint16Array(bytes.buffer, at, size / 2)
        const u32 = new Uint32Array(u16.length)
        for (let i = 0; i < u16.length; i++) u32[i] = u16[i]! << 16
        values = new Float32Array(u32.buffer)
      } else if (t.dtype === "I32") values = new Int32Array(bytes.buffer, at, size / 4)
      else if (t.dtype === "I64") values = Int32Array.from(new BigInt64Array(bytes.buffer, at, size / 8), Number)
      else throw new Error(`the Potion model has a tensor of an unknown type (${t.dtype})`)
      out.set(name, { shape: t.shape, values })
    }
    return out
  } finally {
    closeSync(fd)
  }
}

/**
 * WebAssembly that adds a row of the table, times a weight, into a sum, 16 floats a step with
 * SIMD: 8x as fast as the same loop in JavaScript, which made up most of embedding a passage.
 * Built with wabt's wat2wasm (`--enable-threads`) from:
 *
 *   (module
 *     (import "env" "memory" (memory 1 65536 shared))
 *     ;; acc[0..dim) += row[0..dim) * w, dim a multiple of 16 (floats); offsets in bytes.
 *     (func (export "add") (param $row i32) (param $acc i32) (param $dim i32) (param $w f32)
 *       (local $end i32) (local $ws v128)
 *       (local.set $ws (f32x4.splat (local.get $w)))
 *       (local.set $end (i32.add (local.get $acc) (i32.shl (local.get $dim) (i32.const 2))))
 *       (loop $l
 *         (v128.store (local.get $acc) (f32x4.add (v128.load (local.get $acc)) (f32x4.mul (v128.load (local.get $row)) (local.get $ws))))
 *         ;; ...and the same at offset=16, offset=32 and offset=48
 *         (local.set $row (i32.add (local.get $row) (i32.const 64)))
 *         (local.set $acc (i32.add (local.get $acc) (i32.const 64)))
 *         (br_if $l (i32.lt_u (local.get $acc) (local.get $end))))))
 */
const ADD_ROW_WASM = "AGFzbQEAAAABCAFgBH9/f30AAhIBA2VudgZtZW1vcnkCAwGAgAQDAgEABwcBA2FkZAAACpsBAZgBAgF/AXsgA/0TIQUgASACQQJ0aiEEA0AgASAB/QAEACAA/QAEACAF/eYB/eQB/QsEACABIAH9AAQQIAD9AAQQIAX95gH95AH9CwQQIAEgAf0ABCAgAP0ABCAgBf3mAf3kAf0LBCAgASAB/QAEMCAA/QAEMCAF/eYB/eQB/QsEMCAAQcAAaiEAIAFBwABqIQEgASAESQ0ACws="
const WASM_PAGE = 65536

let addRowModule: WebAssembly.Module | null | undefined
function addRow(memory: WebAssembly.Memory): ((row: number, acc: number, dim: number, w: number) => void) | null {
  try {
    addRowModule ??= new WebAssembly.Module(Buffer.from(ADD_ROW_WASM, "base64"))
    return new WebAssembly.Instance(addRowModule, { env: { memory } }).exports.add as (row: number, acc: number, dim: number, w: number) => void
  } catch {
    // No SIMD or no shared memory: the JavaScript loop does it.
    addRowModule = null
    return null
  }
}

/** The model's numbers: what a worker is handed to embed with (see `workers.ts`). */
export interface PotionTables {
  dim: number
  /** In `memory`, when there is one, followed by `slots` sums of `dim` floats: one per thread embedding. */
  table: Float32Array
  memory: WebAssembly.Memory | null
  slots: number
  /** Model2Vec's optional token weights and token-to-row mapping. */
  weights: Float32Array | null
  mapping: Int32Array | null
}

/**
 * The model's numbers, from `model.safetensors`. They are in memory that other threads can be
 * handed (`workers.ts`), WebAssembly's where it can add them up (see `ADD_ROW_WASM`), with room
 * for `slots` threads' sums.
 */
export function readTables(model: string, slots = 1): PotionTables {
  let memory: WebAssembly.Memory | null = null
  const tensors = readSafetensors(model, (_name, t) => {
    if (memory || t.shape.length !== 2 || t.shape[1]! % 16) return null
    const size = t.data_offsets[1] - t.data_offsets[0]
    try {
      const pages = Math.ceil((size + slots * t.shape[1]! * 4) / WASM_PAGE)
      memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true })
    } catch {
      return null
    }
    return new Uint8Array(memory.buffer, 0, size)
  })
  const emb = tensors.get("embeddings") ?? [...tensors.values()].find((t) => t.shape.length === 2)
  if (!emb || emb.shape.length !== 2 || !(emb.values instanceof Float32Array)) throw new Error("the Potion model has no embedding table")
  if (memory && emb.values.buffer !== (memory as WebAssembly.Memory).buffer) memory = null
  const share = <T extends Float32Array | Int32Array>(v: T | undefined, type: { new (b: SharedArrayBuffer): T }): T | null => {
    if (!v) return null
    if (v.buffer instanceof SharedArrayBuffer) return v
    const copy = new type(new SharedArrayBuffer(v.byteLength))
    copy.set(v)
    return copy
  }
  const weights = tensors.get("weights")?.values
  const mapping = tensors.get("mapping")?.values
  return {
    dim: emb.shape[1]!,
    table: share(emb.values, Float32Array)!,
    memory,
    slots,
    weights: weights instanceof Float32Array ? share(weights, Float32Array) : null,
    mapping: mapping instanceof Int32Array ? share(mapping, Int32Array) : null,
  }
}

export function readTokenizer(path: string): WordPiece {
  return WordPiece.fromJson(JSON.parse(readFileSync(path, "utf8")))
}

/** The model in memory: its tokenizer and its table of vectors (32-bit floats: 16-bit ones are 4x slower to add up here). */
export class PotionModel {
  /** Each row's weight in the text being embedded: zeros between texts. */
  private counts: Float64Array
  /** Where a text's rows are added up: not in `out`, which may be memory other threads use too (slower). */
  private acc: Float32Array
  private add: ((row: number, acc: number, dim: number, w: number) => void) | null = null

  private constructor(
    readonly tokenizer: WordPiece,
    readonly dim: number,
    private table: Float32Array,
    /** Model2Vec's optional token weights and token-to-row mapping. */
    private weights: Float32Array | null,
    private mapping: Int32Array | null,
    /** The table's WebAssembly memory, and which sum in it is this thread's. */
    memory: WebAssembly.Memory | null = null,
    slot = 0,
  ) {
    this.counts = new Float64Array(table.length / dim)
    this.acc = new Float32Array(dim)
    if (memory) {
      this.add = addRow(memory)
      if (this.add) this.acc = new Float32Array(memory.buffer, table.byteLength + slot * dim * 4, dim)
    }
  }

  /** From the model's files: `model.safetensors` and `tokenizer.json`. */
  static load(model: string, tokenizer: string): PotionModel {
    return PotionModel.fromTables(readTokenizer(tokenizer), readTables(model))
  }

  /** `slot`: which of the tables' sums this thread adds up in. */
  static fromTables(tokenizer: WordPiece, t: PotionTables, slot = 0): PotionModel {
    if (slot >= t.slots) throw new Error("no room for another thread's sums")
    return new PotionModel(tokenizer, t.dim, t.table, t.weights, t.mapping, t.memory, slot)
  }

  /** For tests: a model of these vectors and this vocabulary. */
  static of(vocab: Record<string, number>, rows: number[][]): PotionModel {
    return new PotionModel(new WordPiece(vocab), rows[0]!.length, Float32Array.from(rows.flat()), null, null)
  }

  /** The text's L2-normalized vector into `out` (zeros when it has no known pieces); returns its pieces. */
  embedInto(text: string, out: Float32Array): number {
    const ids = this.tokenizer.encode(text)
    const { dim, table, weights, mapping, acc, add } = this
    acc.fill(0)
    const rows = table.length / dim
    // Each distinct row once, times how often it came up: a passage repeats about half its pieces.
    const counts = this.counts
    const distinct: number[] = []
    for (const id of ids) {
      const row = mapping ? mapping[id]! : id
      if (row < 0 || row >= rows) continue
      if (counts[row] === 0) distinct.push(row)
      counts[row] += weights ? weights[id]! : 1
    }
    for (const row of distinct) {
      const w = counts[row]!
      counts[row] = 0
      if (add) add(row * dim * 4, acc.byteOffset, dim, w)
      else {
        const base = row * dim
        for (let d = 0; d < dim; d++) acc[d]! += table[base + d]! * w
      }
    }
    let n = 0
    for (let d = 0; d < dim; d++) n += acc[d]! * acc[d]!
    const s = n > 0 ? 1 / Math.sqrt(n) : 0
    for (let d = 0; d < dim; d++) out[d] = acc[d]! * s
    return ids.length
  }
}

/** How long Potion embeds before letting the event loop run (a cancel, say): it works synchronously. */
const YIELD_MS = 20

/** Potion as an embedder, alike to the helper's (`helper.ts`) for the indexer and search. */
export class PotionEmbedder implements TextEmbedder {
  private killed = false
  private ranSince = performance.now()

  constructor(private model: PotionModel) {}

  async embedTexts(texts: string[]): Promise<{ vectors: Float32Array; dim: number; tokens: number }> {
    const dim = this.model.dim
    const vectors = new Float32Array(texts.length * dim)
    let tokens = 0
    for (let i = 0; i < texts.length; i++) {
      if (performance.now() - this.ranSince >= YIELD_MS) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        this.ranSince = performance.now()
      }
      if (this.killed) throw new Error("the Potion model was stopped")
      tokens += this.model.embedInto(texts[i]!, vectors.subarray(i * dim, (i + 1) * dim))
    }
    return { vectors, dim, tokens }
  }

  close() {}
  kill() {
    this.killed = true
  }
}
