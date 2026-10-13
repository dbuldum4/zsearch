/**
 * The embedding helper, `zsearch-embed` (native/embed): Granite (see `model.ts`) on llama.cpp, in a
 * process of its own that zsearch talks to over a pipe. It is bundled next to the engine in the
 * Mac app (Contents/Helpers), built with `scripts/build-embed.sh` elsewhere, or named by
 * $ZSEARCH_EMBED (`0` turns semantic search off).
 */
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { trackProcess } from "../util/process.ts"

export function embedToolPath(): string | null {
  const env = process.env.ZSEARCH_EMBED
  if (env !== undefined) return env && env !== "0" && existsSync(env) ? env : null
  const bundled = join(dirname(process.execPath), "zsearch-embed")
  if (existsSync(bundled)) return bundled
  // A checkout where the helper was built (scripts/build-embed.sh).
  const built = join(import.meta.dir, "..", "..", "dist", "zsearch-embed")
  return existsSync(built) ? built : null
}

export interface EmbedderInfo {
  dim: number
  images: boolean
  vectorVersion: number
  batchTokens: number
  maxSeqs: number
}

/** What the indexer and search need of a model: the local embedding helper. */
export interface TextEmbedder {
  /** One L2-normalized vector per text, `dim` floats each, in one array; and the tokens they took. */
  embedTexts(texts: string[]): Promise<{ vectors: Float32Array; dim: number; tokens: number }>
  close(): void
  kill(): void
}

export interface EmbedderOptions {
  tool: string
  model: string
  /** How the model's outputs make one vector: its own setting, unless given. */
  pooling?: "mean" | "cls"
  /** The image encoder: images are embedded only with it. */
  mmproj?: string | null
  threads?: number
  batchTokens?: number
  maxSeqs?: number
  /** Run at a low CPU priority (background indexing). */
  low?: boolean
  /** More arguments, for benchmarks. */
  extra?: string[]
}

export interface ImageVectors {
  vectors: (Float32Array | null)[]
  errors: (string | null)[]
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** One helper process. Requests run one at a time, in order. */
export class Embedder implements TextEmbedder {
  private proc: ReturnType<typeof Bun.spawn>
  private reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> }
  private buf: Uint8Array = new Uint8Array(0)
  private queue: Promise<unknown> = Promise.resolve()
  private stderr = ""
  private closed = false
  readonly exited: Promise<number>

  constructor(readonly opts: EmbedderOptions) {
    const args = [opts.tool, "--model", opts.model]
    if (opts.mmproj) args.push("--mmproj", opts.mmproj)
    if (opts.pooling) args.push("--pooling", opts.pooling)
    if (opts.threads) args.push("--threads", String(opts.threads))
    if (opts.batchTokens) args.push("--batch-tokens", String(opts.batchTokens))
    if (opts.maxSeqs) args.push("--max-seqs", String(opts.maxSeqs))
    if (opts.extra) args.push(...opts.extra)
    const nice = opts.low && process.platform !== "win32" && existsSync("/usr/bin/nice") ? ["/usr/bin/nice", "-n", "10"] : []
    this.proc = trackProcess(Bun.spawn([...nice, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env }))
    this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader() as unknown as typeof this.reader
    this.exited = this.proc.exited
    void this.drainStderr()
  }

  private async drainStderr() {
    const r = (this.proc.stderr as ReadableStream<Uint8Array>).getReader()
    try {
      for (;;) {
        const { value, done } = await r.read()
        if (done) break
        // The last few lines say why it failed, when it does.
        this.stderr = (this.stderr + decoder.decode(value)).slice(-2000)
      }
    } catch {}
  }

  private why(): string {
    const lines = this.stderr.trim().split("\n").filter(Boolean)
    return lines.slice(-3).join("; ") || "the embedding helper stopped"
  }

  private async readMessage(): Promise<Uint8Array> {
    for (;;) {
      if (this.buf.length >= 4) {
        const n = (this.buf[0]! | (this.buf[1]! << 8) | (this.buf[2]! << 16) | (this.buf[3]! << 24)) >>> 0
        if (this.buf.length >= 4 + n) {
          const msg = this.buf.slice(4, 4 + n)
          this.buf = this.buf.subarray(4 + n)
          return msg
        }
      }
      const { value, done } = await this.reader.read()
      if (done || !value) {
        await Promise.race([this.exited, Bun.sleep(200)])
        throw new Error(this.why())
      }
      if (!this.buf.length) this.buf = value
      else {
        const next = new Uint8Array(this.buf.length + value.length)
        next.set(this.buf)
        next.set(value, this.buf.length)
        this.buf = next
      }
    }
  }

  private request<T>(parts: Uint8Array[], parse: (msg: Uint8Array, view: DataView) => T): Promise<T> {
    const run = async () => {
      if (this.closed) throw new Error("the embedding helper was closed")
      let len = 0
      for (const p of parts) len += p.length
      const out = new Uint8Array(4 + len)
      new DataView(out.buffer).setUint32(0, len, true)
      let pos = 4
      for (const p of parts) { out.set(p, pos); pos += p.length }
      const stdin = this.proc.stdin as import("bun").FileSink
      try {
        stdin.write(out)
        await stdin.flush()
      } catch {
        // The helper quit (a model it can't load, say): say what it said rather than "broken pipe".
        await Promise.race([this.exited, Bun.sleep(200)])
        throw new Error(this.why())
      }
      const msg = await this.readMessage()
      const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength)
      if (msg[0] !== 0) throw new Error(decoder.decode(msg.subarray(5, 5 + view.getUint32(1, true))))
      return parse(msg, view)
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }

  info(): Promise<EmbedderInfo> {
    return this.request([new Uint8Array([105])], (msg, view) => JSON.parse(decoder.decode(msg.subarray(5, 5 + view.getUint32(1, true)))))
  }

  /** One L2-normalized vector per text, `dim` floats each, in one array; and the tokens they took. */
  embedTexts(texts: string[]): Promise<{ vectors: Float32Array; dim: number; tokens: number }> {
    const parts: Uint8Array[] = [new Uint8Array([116]), u32(texts.length)]
    for (const t of texts) {
      const b = encoder.encode(t)
      parts.push(u32(b.length), b)
    }
    return this.request(parts, (msg, view) => {
      const n = view.getUint32(1, true)
      const dim = view.getUint32(5, true)
      const tokens = view.getUint32(9, true)
      if (n !== texts.length) throw new Error("the embedding helper answered for other inputs")
      return { vectors: new Float32Array(msg.slice(13, 13 + n * dim * 4).buffer), dim, tokens }
    })
  }

  /** One vector per image, or why it has none (`budget`: the encoder's tokens, 70 to 1120). */
  embedImages(paths: string[], budget: number): Promise<ImageVectors> {
    const parts: Uint8Array[] = [new Uint8Array([109]), u32(budget), u32(paths.length)]
    for (const p of paths) {
      const b = encoder.encode(p)
      parts.push(u32(b.length), b)
    }
    return this.request(parts, (msg, view) => {
      const n = view.getUint32(1, true)
      const dim = view.getUint32(5, true)
      const vectors: (Float32Array | null)[] = []
      const errors: (string | null)[] = []
      let pos = 9
      for (let i = 0; i < n; i++) {
        if (msg[pos++] === 1) {
          vectors.push(new Float32Array(msg.slice(pos, pos + dim * 4).buffer))
          errors.push(null)
          pos += dim * 4
        } else {
          const len = view.getUint32(pos, true)
          errors.push(decoder.decode(msg.subarray(pos + 4, pos + 4 + len)))
          vectors.push(null)
          pos += 4 + len
        }
      }
      return { vectors, errors }
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      const stdin = this.proc.stdin as import("bun").FileSink
      stdin.write(new Uint8Array([1, 0, 0, 0, 113]))
      void stdin.end()
    } catch {}
    const proc = this.proc
    setTimeout(() => { try { proc.kill() } catch {} }, 2000).unref?.()
  }

  kill() {
    this.closed = true
    try { this.proc.kill() } catch {}
  }
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}
