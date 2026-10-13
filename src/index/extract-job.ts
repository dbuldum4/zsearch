import { type ExtractOptions, extractRaw, textOf } from "./extract/index.ts"
import { compressBytes, encodeText, textHash } from "./db.ts"
import type { OcrMemo } from "./extract/ocr.ts"
import { byteTerms } from "./byte-terms.ts"
import { indexTerms } from "../util/text.ts"
import type { Kind } from "../kinds.ts"
import { fileMetadata, metadataText } from "./extract/metadata.ts"
import { pathPolicy } from "./policy.ts"
import { holdsPrivateKey, onlyKeys, redactPrivateKeys, SECRET_NOTE } from "./secrets.ts"
import { meaningOnly } from "../profile.ts"

const encoder = new TextEncoder()

/** Jobs a worker extracts at once: one can wait (on pdftotext, say) while another computes. */
export const JOBS_AT_ONCE = 2

export interface ExtractJob {
  /** Identifies the indexing run: vocabulary de-duplication is per run (and per database). */
  run: string
  id: number
  path: string
  size: number
  ext: string
  kind: Kind
  /** What OCR read in this file before, if it was read (see `ocr_cache`). */
  ocr?: string
}

export type ExtractReply =
  | {
      id: number
      status: "ok"
      /** Length of the extracted text. */
      chars: number
      /**
       * Its distinct words, for the full-text index (see `ftsBody`), in UTF-8: bytes go from
       * thread to thread without a copy, and SQLite reads them as the same text.
       */
      body: Uint8Array
      compressed: Uint8Array
      /** Identifies the text (see `textHash`): files with the same text share it. */
      hash: Uint8Array
      /** What OCR read, compressed, when it read the whole file now: kept for later runs. */
      ocr?: Uint8Array
      terms: string[]
      truncated: boolean
      metadata?: Record<string, string>
    }
  | { id: number; status: "skip"; reason: string }
  | { id: number; status: "error"; error: string }

/**
 * Terms this thread already reported during the current run. The indexer only needs
 * each vocabulary term once; filtering here keeps the (single) writer thread free.
 * Bounded so a huge vocabulary cannot exhaust memory: clearing just means a few
 * terms are reported twice, which the database ignores.
 */
const reported = new Set<string>()
let reportedRun = ""
const MAX_REPORTED = 250_000

function newTerms(terms: Iterable<string>, run: string): string[] {
  if (run !== reportedRun) {
    reported.clear()
    reportedRun = run
  }
  const out: string[] = []
  for (const t of terms) {
    if (reported.has(t)) continue
    if (reported.size >= MAX_REPORTED) reported.clear()
    reported.add(t)
    out.push(t)
  }
  return out
}

/** The buffers of an extracted file's reply, which go to another thread without a copy. */
export function replyBuffers(r: { body: Uint8Array; compressed: Uint8Array; hash: Uint8Array; ocr?: Uint8Array }): ArrayBuffer[] {
  const out = [r.body.buffer as ArrayBuffer, r.compressed.buffer as ArrayBuffer, r.hash.buffer as ArrayBuffer]
  if (r.ocr) out.push(r.ocr.buffer as ArrayBuffer)
  return out
}

/** Only white space, which extraction takes as empty. */
function blank(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b !== 32 && (b < 9 || b > 13)) return false
  return true
}

/** The text with its line ends as extraction leaves them (see `finish` there): \r\n and \r become \n. */
function lineFeeds(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const n = bytes.length
  let i = bytes.indexOf(13)
  if (i < 0) return bytes as Uint8Array<ArrayBuffer>
  const out = new Uint8Array(n)
  out.set(bytes.subarray(0, i))
  let o = i
  for (; i < n; i++) {
    const b = bytes[i]!
    if (b !== 13) out[o++] = b
    else if (bytes[i + 1] !== 10) out[o++] = 10
  }
  return out.slice(0, o)
}

/** Read a file, extract its text, compress it and list its (new) vocabulary. */
export async function processJob(job: ExtractJob, opts: ExtractOptions): Promise<ExtractReply> {
  try {
    // Text extraction rechecks policy itself; only metadata needs an earlier read.
    const policy = opts.metadata && opts.policy ? pathPolicy(job.path, opts.policy) : null
    if (opts.contentEnabled === false || (policy && (!policy.allowed || !policy.content))) return { id: job.id, status: "skip", reason: "unsupported" }
    const metadata = opts.metadata ? await fileMetadata(policy?.real ?? job.path, job.ext) : {}
    const extra = metadataText(metadata)
    const memo: OcrMemo = { cached: job.ocr }
    let raw = await extractRaw(job.path, job.size, job.ext, job.kind, opts, memo)
    if (extra) {
      const text = raw.status === "bytes" ? textOf(raw.bytes, opts.maxChars) : raw
      raw = { status: "ok", text: `${extra}\n\n${text.status === "ok" ? text.text : ""}`.slice(0, opts.maxChars), truncated: text.status === "ok" && (text.truncated || text.text.length + extra.length > opts.maxChars) }
    }
    if (!meaningOnly() && raw.status === "bytes" && raw.bytes.length <= opts.maxChars) {
      // UTF-8 text is stored as it is, and its words need no decoding.
      const a = byteTerms(raw.bytes, job.run)
      if (a) {
        if (!a.body.length && blank(raw.bytes)) return { id: job.id, status: "skip", reason: "empty" }
        const text = lineFeeds(raw.bytes)
        const compressed = compressBytes(text)
        return { id: job.id, status: "ok", chars: text.length - a.wide, body: a.body, compressed, hash: textHash(text), terms: a.report(), truncated: false }
      }
    }
    let r = raw.status === "bytes" ? textOf(raw.bytes, opts.maxChars) : raw
    if (r.status === "skip") return { id: job.id, status: "skip", reason: r.reason }
    // Documents too: keys are cut out, and a document that is all key is a key file.
    if (holdsPrivateKey(r.text)) {
      const text = redactPrivateKeys(r.text)
      if (onlyKeys(text)) return { id: job.id, status: "skip", reason: SECRET_NOTE }
      r = { ...r, text }
    }
    const { body, terms } = meaningOnly() ? { body: "", terms: [] } : indexTerms(r.text)
    const bytes = encodeText(r.text)
    return {
      id: job.id,
      status: "ok",
      chars: r.text.length,
      body: encoder.encode(body),
      compressed: compressBytes(bytes),
      hash: textHash(bytes),
      // Text with a key in it is not kept for later, even though the key is cut out of what is stored.
      ...(memo.fresh !== undefined && !holdsPrivateKey(memo.fresh) ? { ocr: compressBytes(encodeText(memo.fresh)) } : {}),
      terms: newTerms(terms, job.run),
      truncated: r.truncated,
      metadata,
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    const msg =
      e.code === "EACCES" || e.code === "EPERM"
        ? "permission denied"
        : e.code === "ENOENT"
          ? "file disappeared"
          : (e.message || String(err)).replace(/\s+/g, " ").slice(0, 200)
    return { id: job.id, status: "error", error: msg }
  }
}
