import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import type { SemanticConfig } from "../config.ts"
import { expandHome, paths } from "../config.ts"
import { MODEL2VEC_FILES, Model2Vec } from "./model2vec.ts"
import { normalize } from "./vectors.ts"

export interface Embedder {
  /** Stable identifier; changing it invalidates stored vectors. */
  readonly id: string
  readonly dims: number
  /** Embed passages (documents). */
  embedDocuments(texts: string[]): Promise<Float32Array[]>
  /** Embed a search query. */
  embedQuery(text: string): Promise<Float32Array>
}

export type DownloadProgress = (file: string, received: number, total: number) => void

export function hfEndpoint(): string {
  return (process.env.HF_ENDPOINT || "https://huggingface.co").replace(/\/+$/, "")
}

/** Local folder of a model2vec model: an explicit path, or the download cache. */
export function model2vecDir(model: string): string {
  const expanded = expandHome(model)
  if (isAbsolute(expanded) || model.startsWith(".")) return expanded
  return join(paths().models, model.replace(/\//g, "--"))
}

export function model2vecInstalled(model: string): boolean {
  const dir = model2vecDir(model)
  return MODEL2VEC_FILES.every((f) => existsSync(join(dir, f)))
}

/** Download a model2vec model from the Hugging Face hub into the cache. */
export async function downloadModel2Vec(model: string, onProgress?: DownloadProgress, signal?: AbortSignal): Promise<string> {
  const dir = model2vecDir(model)
  if (model2vecInstalled(model)) return dir
  if (isAbsolute(expandHome(model))) throw new Error(`model folder ${dir} is missing config.json, tokenizer.json or model.safetensors`)
  mkdirSync(dir, { recursive: true })
  for (const file of MODEL2VEC_FILES) {
    const target = join(dir, file)
    if (existsSync(target)) continue
    const url = `${hfEndpoint()}/${model}/resolve/main/${file}`
    let res: Response
    try {
      res = await fetch(url, { signal, redirect: "follow" })
    } catch (err) {
      throw new Error(`could not reach ${hfEndpoint()} to download ${model} (${(err as Error).message}). Check your connection or set HF_ENDPOINT.`)
    }
    if (!res.ok || !res.body) throw new Error(`downloading ${url} failed: HTTP ${res.status}`)
    const total = Number(res.headers.get("content-length") ?? 0)
    const part = `${target}.part`
    const out = createWriteStream(part)
    let received = 0
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r))
        onProgress?.(file, received, total)
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    } catch (err) {
      out.destroy()
      rmSync(part, { force: true })
      throw err
    }
    if (total && statSync(part).size !== total) {
      rmSync(part, { force: true })
      throw new Error(`incomplete download of ${file}`)
    }
    renameSync(part, target)
  }
  return dir
}

class Model2VecEmbedder implements Embedder {
  readonly id: string
  readonly dims: number
  constructor(
    private model: Model2Vec,
    name: string,
  ) {
    this.id = `model2vec:${name}`
    this.dims = model.dims
  }
  async embedDocuments(texts: string[]) {
    return this.model.embed(texts)
  }
  async embedQuery(text: string) {
    return this.model.embedOne(text)
  }
}

/** Prompt prefixes some embedding models expect. */
function prefixes(model: string): { query: string; doc: string } {
  const m = model.toLowerCase()
  if (m.includes("nomic")) return { query: "search_query: ", doc: "search_document: " }
  if (m.includes("e5")) return { query: "query: ", doc: "passage: " }
  if (m.includes("mxbai") || m.includes("bge")) return { query: "Represent this sentence for searching relevant passages: ", doc: "" }
  if (m.includes("snowflake-arctic")) return { query: "Represent this sentence for searching relevant passages: ", doc: "" }
  return { query: "", doc: "" }
}

class HttpEmbedder implements Embedder {
  readonly id: string
  dims = 0
  private pre: { query: string; doc: string }
  constructor(
    private kind: "ollama" | "openai",
    private url: string,
    private model: string,
    private apiKey: string | undefined,
  ) {
    this.id = `${kind}:${model}`
    this.pre = prefixes(model)
  }

  private async call(input: string[]): Promise<Float32Array[]> {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    const endpoint = this.kind === "ollama" ? `${this.url}/api/embed` : `${this.url}/embeddings`
    let res: Response
    try {
      res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: this.model, input }) })
    } catch (err) {
      throw new Error(`cannot reach ${this.kind} at ${this.url}: ${(err as Error).message}`)
    }
    if (!res.ok) throw new Error(`${this.kind} embeddings failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { embeddings?: number[][]; data?: { embedding: number[]; index: number }[] }
    const rows = body.embeddings ?? (body.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding)
    if (rows.length !== input.length) throw new Error(`${this.kind} returned ${rows.length} embeddings for ${input.length} inputs`)
    const out = rows.map((r) => normalize(Float32Array.from(r)))
    if (out[0]) this.dims = out[0].length
    return out
  }

  async embedDocuments(texts: string[]) {
    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i += 32) out.push(...(await this.call(texts.slice(i, i + 32).map((t) => this.pre.doc + t))))
    return out
  }

  async embedQuery(text: string) {
    return (await this.call([this.pre.query + text]))[0]!
  }
}

export interface CreateEmbedderOptions {
  /** Allow downloading model files (default true). */
  download?: boolean
  onDownload?: DownloadProgress
  signal?: AbortSignal
}

export async function createEmbedder(cfg: SemanticConfig, opts: CreateEmbedderOptions = {}): Promise<Embedder> {
  if (cfg.provider === "ollama") {
    const e = new HttpEmbedder("ollama", (cfg.url || "http://localhost:11434").replace(/\/+$/, ""), cfg.model || "nomic-embed-text", undefined)
    await e.embedQuery("warm up")
    return e
  }
  if (cfg.provider === "openai") {
    const key = process.env[cfg.apiKeyEnv || "OPENAI_API_KEY"]
    const url = (cfg.url || "https://api.openai.com/v1").replace(/\/+$/, "")
    if (!key && url.includes("api.openai.com")) throw new Error(`set ${cfg.apiKeyEnv || "OPENAI_API_KEY"} to use the openai provider`)
    const e = new HttpEmbedder("openai", url, cfg.model || "text-embedding-3-small", key)
    await e.embedQuery("warm up")
    return e
  }
  const name = cfg.model || "minishlab/potion-base-8M"
  if (!model2vecInstalled(name)) {
    if (opts.download === false) throw new Error(`semantic model ${name} is not downloaded yet`)
    await downloadModel2Vec(name, opts.onDownload, opts.signal)
  }
  return new Model2VecEmbedder(Model2Vec.load(model2vecDir(name)), name)
}

/** The identifier an embedder for this config would report, without loading it. */
export function embedderId(cfg: SemanticConfig): string {
  if (cfg.provider === "ollama") return `ollama:${cfg.model || "nomic-embed-text"}`
  if (cfg.provider === "openai") return `openai:${cfg.model || "text-embedding-3-small"}`
  return `model2vec:${cfg.model || "minishlab/potion-base-8M"}`
}
