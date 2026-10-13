/**
 * IBM's pinned Granite embedding model, run locally by the llama.cpp helper.
 * The Mac app downloads it at startup unless semantic search is off; the CLI uses
 * `zsearch semantic install`. Downloads resume and are checked before installation.
 */
import { createHash, type Hash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../config.ts"

export interface ModelFile {
  name: string
  bytes: number
  /** SHA-256 of the file (Hugging Face lists it for files kept with Git LFS)... */
  sha256?: string
  /** ...or its Git blob id (SHA-1), for small files kept in Git itself. */
  gitOid?: string
}

export interface ModelSpec {
  name: string
  repository: string
  revision: string
  license: string
  /** Its folder in the models folder. */
  folder: string
  files: ModelFile[]
}

export const GRANITE: ModelSpec = {
  name: "granite-embedding-small-english-r2",
  repository: "mradermacher/granite-embedding-small-english-r2-GGUF",
  revision: "2b2ad9b58f3e382821e007f4c924101d6bd4a5e2",
  license: "Apache 2.0",
  folder: "granite-embedding-small-english-r2",
  files: [{ name: "granite-embedding-small-english-r2.Q8_0.gguf", bytes: 52_445_632, sha256: "d4b41f5d7db712806722103a1c6aba2f0fe99f77740501d6f313c8240641f145" }],
}

export const MODELS: ModelSpec[] = [GRANITE]

export function modelUrl(spec: ModelSpec, file: ModelFile): string {
  return `https://huggingface.co/${spec.repository}/resolve/${spec.revision}/${file.name}`
}

/** The models folder: `$ZSEARCH_MODELS` (tests and benchmarks: every file in it, unchecked), or one in zsearch's data folder. */
export function modelsRoot(): string {
  return process.env.ZSEARCH_MODELS || join(paths().data, "models")
}

export function modelDir(spec: ModelSpec): string {
  return process.env.ZSEARCH_MODELS || join(modelsRoot(), spec.folder)
}

/** A model's files, in the order its spec lists them, or null when one is missing. A file only gets its final name once its checksum matched. */
export function installedModel(spec: ModelSpec): string[] | null {
  const dir = modelDir(spec)
  const out: string[] = []
  for (const f of spec.files) {
    const p = join(dir, f.name)
    try {
      if (statSync(p).size !== f.bytes && !process.env.ZSEARCH_MODELS) return null
    } catch {
      return null
    }
    out.push(p)
  }
  return out
}

/** What the model is, for fingerprints: a different model or revision means different vectors. */
export function modelFingerprint(spec: ModelSpec): string {
  return `${spec.repository}@${spec.revision}`
}

export interface DownloadProgress {
  file: string
  received: number
  total: number
}

export interface DownloadOptions {
  signal?: AbortSignal
  onProgress?: (p: DownloadProgress) => void
  fetchImpl?: typeof fetch
}

/**
 * Download the Granite model, checking
 * each file's size and checksum before giving it its name. A `.part` file left by an interrupted
 * download is continued.
 */
export async function downloadModels(opts: DownloadOptions = {}): Promise<void> {
  // EmbeddingGemma 2, which earlier versions ran, takes 310 to 865 MB: no longer used.
  rmSync(join(paths().data, "models", "embeddinggemma-2"), { recursive: true, force: true })
  for (const spec of MODELS) {
    const dir = modelDir(spec)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const file of spec.files) {
      const final = join(dir, file.name)
      if (existsSync(final) && statSync(final).size === file.bytes) continue
      await downloadFile(spec, file, final, opts)
    }
  }
}

function checksum(file: ModelFile): Hash {
  if (file.sha256) return createHash("sha256")
  // A Git blob id is the SHA-1 of a header and the contents.
  return createHash("sha1").update(`blob ${file.bytes}\0`)
}

async function downloadFile(spec: ModelSpec, file: ModelFile, final: string, opts: DownloadOptions) {
  const part = `${final}.part`
  const hash = checksum(file)
  let have = 0
  if (existsSync(part)) {
    // Continue where it stopped: hash what is there first.
    have = statSync(part).size
    if (have > file.bytes) { rmSync(part); have = 0 }
    else {
      const fd = openSync(part, "r")
      try {
        const buf = new Uint8Array(8 << 20)
        for (let pos = 0; pos < have;) {
          const n = readSync(fd, buf, 0, Math.min(buf.length, have - pos), pos)
          if (!n) break
          hash.update(buf.subarray(0, n))
          pos += n
        }
      } finally { closeSync(fd) }
    }
  }
  if (have < file.bytes) {
    const res = await (opts.fetchImpl ?? fetch)(modelUrl(spec, file), { signal: opts.signal, headers: have ? { Range: `bytes=${have}-` } : {}, redirect: "follow" })
    if (have && res.status === 200) {
      // The server sent the whole file rather than the rest: start over.
      await res.body?.cancel()
      rmSync(part, { force: true })
      return downloadFile(spec, file, final, opts)
    }
    if (!res.ok || !res.body) throw new Error(`downloading ${file.name} failed: HTTP ${res.status}`)
    const fd = openSync(part, have ? "a" : "w", 0o600)
    try {
      const reader = res.body.getReader()
      let last = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (have + value.length > file.bytes) throw new Error(`${file.name} is larger than expected`)
        writeSync(fd, value)
        hash.update(value)
        have += value.length
        const now = Date.now()
        if (now - last > 200) { last = now; opts.onProgress?.({ file: file.name, received: have, total: file.bytes }) }
      }
    } finally { closeSync(fd) }
  }
  opts.onProgress?.({ file: file.name, received: have, total: file.bytes })
  const digest = hash.digest("hex")
  if (have !== file.bytes || digest !== (file.sha256 ?? file.gitOid)) {
    rmSync(part, { force: true })
    throw new Error(`${file.name} did not match its checksum (got ${have} bytes, ${digest.slice(0, 12)}…); nothing was installed`)
  }
  renameSync(part, final)
}

/** Bytes to download for the model. */
export function modelBytes(spec?: ModelSpec): number {
  return (spec ? [spec] : MODELS).reduce((s, m) => s + m.files.reduce((t, f) => t + f.bytes, 0), 0)
}

/** Delete the models (and any partial download, and the model earlier versions ran). */
export function removeModels(): void {
  if (process.env.ZSEARCH_MODELS) return
  for (const spec of MODELS) rmSync(join(modelsRoot(), spec.folder), { recursive: true, force: true })
  rmSync(join(modelsRoot(), "embeddinggemma-2"), { recursive: true, force: true })
  rmSync(join(modelsRoot(), "potion-retrieval-32M"), { recursive: true, force: true })
}
