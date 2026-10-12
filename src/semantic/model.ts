/**
 * The model semantic search runs, EmbeddingGemma 2 by Google DeepMind, in ggml-org's 8-bit GGUF
 * conversion at one pinned revision: the files DigUp runs (its `ModelFiles.swift`), with their
 * sizes and SHA-256 sums. Nothing is bundled: `zsearch semantic install` (or the Mac app's
 * settings) downloads them, and only then does zsearch make a network request at all.
 *
 * The text part (310 MB) is all that documents and queries need. The image encoder (555 MB) lets
 * the Mac app find photos by what they show; it is optional.
 */
import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../config.ts"

export const MODEL_REPOSITORY = "ggml-org/embeddinggemma-2-GGUF"
export const MODEL_REVISION = "bfcd298762cc34d0357ece5ebdd31791a3a374d8"
export const MODEL_LICENSE = "Apache 2.0 (as its model card and DigUp state it)"

export interface ModelFile {
  name: string
  bytes: number
  sha256: string
}

export const TEXT_MODEL: ModelFile = { name: "embeddinggemma-2-Q8_0.gguf", bytes: 309_855_456, sha256: "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135" }
export const MEDIA_MODEL: ModelFile = { name: "mmproj-embeddinggemma-2-Q8_0.gguf", bytes: 554_821_024, sha256: "c4a8a52691ecef40618438928bdf9e68379b854e24166f292592353db0aab64f" }

export function modelUrl(file: ModelFile): string {
  return `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/${file.name}`
}

/** Where the model files live: `$ZSEARCH_MODELS`, or a folder in zsearch's data folder. */
export function modelDir(): string {
  return process.env.ZSEARCH_MODELS || join(paths().data, "models", "embeddinggemma-2")
}

export interface InstalledModel {
  text: string | null
  media: string | null
}

/** The model files that are there. A file only gets its final name once its checksum matched. */
export function installedModel(dir = modelDir()): InstalledModel {
  const at = (f: ModelFile) => {
    const p = join(dir, f.name)
    // A folder named by $ZSEARCH_MODELS may hold other builds of the model (tests, benchmarks).
    try { return statSync(p).size === f.bytes || process.env.ZSEARCH_MODELS ? p : null } catch { return null }
  }
  return { text: at(TEXT_MODEL), media: at(MEDIA_MODEL) }
}

/** What the model is, for fingerprints: a different model or revision means different vectors. */
export function modelFingerprint(): string {
  return `${MODEL_REPOSITORY}@${MODEL_REVISION}`
}

export interface DownloadProgress {
  file: string
  received: number
  total: number
}

/**
 * Download the model files that are missing into `dir`, checking each one's size and SHA-256
 * before giving it its name. A `.part` file left by an interrupted download is continued.
 */
export async function downloadModel(opts: { media: boolean; dir?: string; signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void; fetchImpl?: typeof fetch }): Promise<InstalledModel> {
  const dir = opts.dir ?? modelDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const files = opts.media ? [TEXT_MODEL, MEDIA_MODEL] : [TEXT_MODEL]
  for (const file of files) {
    const final = join(dir, file.name)
    if (existsSync(final) && statSync(final).size === file.bytes) continue
    await downloadFile(file, final, opts)
  }
  return installedModel(dir)
}

async function downloadFile(file: ModelFile, final: string, opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void; fetchImpl?: typeof fetch }) {
  const part = `${final}.part`
  const hash = createHash("sha256")
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
    const res = await (opts.fetchImpl ?? fetch)(modelUrl(file), { signal: opts.signal, headers: have ? { Range: `bytes=${have}-` } : {}, redirect: "follow" })
    if (have && res.status === 200) {
      // The server sent the whole file rather than the rest: start over.
      await res.body?.cancel()
      rmSync(part, { force: true })
      return downloadFile(file, final, opts)
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
  if (have !== file.bytes || digest !== file.sha256) {
    rmSync(part, { force: true })
    throw new Error(`${file.name} did not match its checksum (got ${have} bytes, sha256 ${digest.slice(0, 12)}…); nothing was installed`)
  }
  renameSync(part, final)
}

/** Delete the model files (and any partial download). */
export function removeModel(dir = modelDir()): void {
  for (const f of [TEXT_MODEL, MEDIA_MODEL]) for (const p of [join(dir, f.name), join(dir, `${f.name}.part`)]) rmSync(p, { force: true })
}
