import { type ExtractOptions, extract } from "./extract/index.ts"
import { compressText } from "./db.ts"
import { indexTerms } from "../util/text.ts"
import type { Kind } from "../kinds.ts"

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
      terms: string[]
      truncated: boolean
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

/** Read a file, extract its text, compress it and list its (new) vocabulary. */
export async function processJob(job: ExtractJob, opts: ExtractOptions): Promise<ExtractReply> {
  try {
    const r = await extract(job.path, job.size, job.ext, job.kind, opts)
    if (r.status === "skip") return { id: job.id, status: "skip", reason: r.reason }
    const { body, terms } = indexTerms(r.text)
    return {
      id: job.id,
      status: "ok",
      chars: r.text.length,
      body: encoder.encode(body),
      compressed: compressText(r.text),
      terms: newTerms(terms, job.run),
      truncated: r.truncated,
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
