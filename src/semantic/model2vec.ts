/**
 * Model2Vec static embeddings (https://github.com/MinishLab/model2vec) in plain TypeScript.
 * A model is a token-embedding table: a text embedding is the (weighted) mean of its
 * token vectors, normalised. That makes it hundreds of times faster than a transformer,
 * which is what lets zsearch embed a whole home folder on a laptop CPU.
 */
import { Tokenizer } from "@huggingface/tokenizers"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { normalize } from "./vectors.ts"

interface TensorInfo {
  dtype: string
  shape: number[]
  data_offsets: [number, number]
}

export interface SafeTensors {
  tensors: Map<string, TensorInfo>
  data: Uint8Array
}

export function parseSafetensors(buf: Uint8Array): SafeTensors {
  if (buf.length < 8) throw new Error("safetensors file too small")
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const headerLen = Number(dv.getBigUint64(0, true))
  if (headerLen <= 0 || 8 + headerLen > buf.length) throw new Error("corrupt safetensors header")
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + headerLen))) as Record<string, TensorInfo>
  const tensors = new Map<string, TensorInfo>()
  for (const [k, v] of Object.entries(header)) if (k !== "__metadata__") tensors.set(k, v)
  return { tensors, data: buf.subarray(8 + headerLen) }
}

function f16ToF32(h: number): number {
  const s = (h & 0x8000) >> 15
  const e = (h & 0x7c00) >> 10
  const f = h & 0x03ff
  let v: number
  if (e === 0) v = (f / 1024) * 2 ** -14
  else if (e === 31) v = f ? NaN : Infinity
  else v = (1 + f / 1024) * 2 ** (e - 15)
  return s ? -v : v
}

/** Read a tensor as Float32Array (or Int32Array for integer tensors). */
export function readTensor(st: SafeTensors, name: string): { shape: number[]; f32?: Float32Array; i32?: Int32Array } | null {
  const t = st.tensors.get(name)
  if (!t) return null
  const [a, b] = t.data_offsets
  const bytes = st.data.subarray(a, b)
  const n = t.shape.reduce((x, y) => x * y, 1)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (t.dtype) {
    case "F32": {
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true)
      return { shape: t.shape, f32: out }
    }
    case "F16": {
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = f16ToF32(dv.getUint16(i * 2, true))
      return { shape: t.shape, f32: out }
    }
    case "BF16": {
      const out = new Float32Array(n)
      const tmp = new DataView(new ArrayBuffer(4))
      for (let i = 0; i < n; i++) {
        tmp.setUint32(0, dv.getUint16(i * 2, true) << 16, true)
        out[i] = tmp.getFloat32(0, true)
      }
      return { shape: t.shape, f32: out }
    }
    case "I8": {
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = dv.getInt8(i)
      return { shape: t.shape, f32: out }
    }
    case "I32":
    case "I64": {
      const out = new Int32Array(n)
      for (let i = 0; i < n; i++) out[i] = t.dtype === "I32" ? dv.getInt32(i * 4, true) : Number(dv.getBigInt64(i * 8, true))
      return { shape: t.shape, i32: out }
    }
    default:
      throw new Error(`unsupported tensor dtype ${t.dtype}`)
  }
}

export const MODEL2VEC_FILES = ["config.json", "tokenizer.json", "model.safetensors"] as const

const WORD_CACHE_MAX = 200_000

export class Model2Vec {
  readonly dims: number
  private unkId: number | null
  private maxTokens: number
  /**
   * Token ids per whitespace-separated word. Tokenizers work word by word after
   * pre-tokenization, so caching per word gives the same ids at a fraction of the cost.
   */
  private wordIds = new Map<string, number[]>()
  /** Byte-level BPE (GPT-2 style) marks a preceding space inside the token. */
  private spacePrefix = false

  private constructor(
    private tokenizer: Tokenizer,
    private embeddings: Float32Array,
    private vocab: number,
    dims: number,
    private weights: Float32Array | null,
    private mapping: Int32Array | null,
    private normalizeOut: boolean,
    unkId: number | null,
    maxTokens: number,
  ) {
    this.dims = dims
    this.unkId = unkId
    this.maxTokens = maxTokens
  }

  /** Load from a folder with config.json, tokenizer.json and model.safetensors. */
  static load(dir: string): Model2Vec {
    for (const f of MODEL2VEC_FILES) if (!existsSync(join(dir, f))) throw new Error(`model file missing: ${join(dir, f)}`)
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>
    const tokJson = JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")) as Record<string, unknown>
    const tokenizer = new Tokenizer(tokJson, { tokenizer_class: "PreTrainedTokenizerFast" })
    const st = parseSafetensors(new Uint8Array(readFileSync(join(dir, "model.safetensors"))))
    const emb = readTensor(st, "embeddings") ?? readTensor(st, "embedding") ?? readTensor(st, [...st.tensors.keys()][0]!)
    if (!emb?.f32 || emb.shape.length !== 2) throw new Error("model.safetensors has no 2-D embeddings tensor")
    const [vocab, dims] = emb.shape as [number, number]
    const weights = readTensor(st, "weights")?.f32 ?? null
    const mapping = readTensor(st, "mapping")?.i32 ?? null
    const model = (tokJson.model ?? {}) as { unk_token?: string; vocab?: Record<string, number> | [string, number][] }
    let unkId: number | null = null
    if (model.unk_token && model.vocab && !Array.isArray(model.vocab)) unkId = model.vocab[model.unk_token] ?? null
    const m = new Model2Vec(tokenizer, emb.f32, vocab, dims, weights, mapping, config.normalize !== false, unkId, 512)
    m.spacePrefix = JSON.stringify(tokJson.pre_tokenizer ?? null).includes("ByteLevel")
    return m
  }

  private tokenize(text: string): number[] {
    const out: number[] = []
    let first = true
    for (const word of text.split(/\s+/)) {
      if (!word) continue
      const key = this.spacePrefix && !first ? ` ${word}` : word
      first = false
      let ids = this.wordIds.get(key)
      if (!ids) {
        try {
          ids = this.tokenizer.encode(key, { add_special_tokens: false }).ids as number[]
        } catch {
          ids = []
        }
        if (this.wordIds.size >= WORD_CACHE_MAX) this.wordIds.clear()
        this.wordIds.set(key, ids)
      }
      for (const id of ids) out.push(id)
      if (out.length >= this.maxTokens) break
    }
    return out
  }

  embedOne(text: string): Float32Array {
    const out = new Float32Array(this.dims)
    const ids = this.tokenize(text)
    let n = 0
    const limit = Math.min(ids.length, this.maxTokens)
    for (let i = 0; i < limit; i++) {
      let id = ids[i]!
      if (id === this.unkId) continue
      if (this.mapping) id = this.mapping[id] ?? -1
      if (id < 0 || id >= this.vocab) continue
      const w = this.weights ? (this.weights[ids[i]!] ?? 1) : 1
      const off = id * this.dims
      for (let d = 0; d < this.dims; d++) out[d] += this.embeddings[off + d]! * w
      n++
    }
    if (n === 0) return out
    for (let d = 0; d < this.dims; d++) out[d] /= n
    return this.normalizeOut ? normalize(out) : out
  }

  embed(texts: string[]): Float32Array[] {
    return texts.map((t) => this.embedOne(t))
  }
}
