/**
 * How long a first index of a folder takes, roughly, from a quick count-only walk: no file is
 * opened. Setup shows it next to each choice before anything is indexed.
 */
import { type Config, resolvePath } from "../config.ts"
import { DOCUMENT_EXTS, extOf, kindOf, OCR_EXTS } from "../kinds.ts"
import { ocrToolPath } from "../platform.ts"
import { formatCount } from "../util/text.ts"
import { workerUrl } from "../util/workers.ts"
import { crawl } from "./crawler.ts"
import { wantsContent } from "./extract/index.ts"
import { defaultWorkers, loadShare } from "./load.ts"
import { crawlOptionsFor } from "./policy.ts"
import { secretFile } from "./secrets.ts"

export interface FolderEstimate {
  /** The folder as given (`~/Documents`). */
  root: string
  files: number
  folders: number
  /** Plain text and code to read, and its size (up to the per-file limit). */
  textFiles: number
  textBytes: number
  /** PDFs, Office files and other documents to open. */
  documents: number
  /** Images to read with OCR. */
  ocrImages: number
  /** The walk finished in time: otherwise the counts and time are a lower bound. */
  complete: boolean
  /** The first pass, roughly. */
  seconds: number
}

/**
 * Rough costs of a first pass, rounded towards slower: walking folders, reading text (per file
 * and per byte, which includes compressing and indexing it), opening documents and OCR. Per
 * extraction worker, except the walk. Fitted to `zsearch index` runs on a 4-core cloud machine.
 */
const SCAN_PER_SECOND = 15_000
const SECONDS_PER_TEXT_FILE = 0.0003
const TEXT_BYTES_PER_SECOND = 12 * 1024 * 1024
const SECONDS_PER_DOCUMENT = 0.06
const SECONDS_PER_OCR_IMAGE = 0.2

/** How long one folder's walk may take before the estimate gives a lower bound. */
export const ESTIMATE_BUDGET_MS = 3000

/** The time a first pass takes for these counts, in seconds. */
export function firstPassSeconds(c: Pick<FolderEstimate, "files" | "folders" | "textFiles" | "textBytes" | "documents" | "ocrImages">, workers: number): number {
  const scan = (c.files + c.folders) / SCAN_PER_SECOND
  const read = c.textFiles * SECONDS_PER_TEXT_FILE + c.textBytes / TEXT_BYTES_PER_SECOND + c.documents * SECONDS_PER_DOCUMENT
  // OCR shares the computer's neural engine and GPU: more workers help less.
  const ocr = c.ocrImages * SECONDS_PER_OCR_IMAGE
  return scan + read / workers + ocr / Math.max(1, Math.ceil(workers / 2))
}

/** Count what a first index of `root` reads, under the current settings. */
export function estimateFolder(root: string, config: Config, budgetMs = ESTIMATE_BUDGET_MS, now: () => number = Date.now): FolderEstimate {
  const opts = crawlOptionsFor({ ...config, roots: [root] })
  const ocr = config.content.enabled && config.content.ocr && ocrToolPath() !== null
  const maxText = config.content.maxTextMB * 1024 * 1024
  const maxDoc = config.content.maxDocumentMB * 1024 * 1024
  const e: FolderEstimate = { root, files: 0, folders: 0, textFiles: 0, textBytes: 0, documents: 0, ocrImages: 0, complete: true, seconds: 0 }
  const deadline = now() + budgetMs
  let n = 0
  for (const entry of crawl(opts)) {
    if ((++n & 1023) === 0 && now() > deadline) { e.complete = false; break }
    if (entry.isDir) { e.folders++; continue }
    e.files++
    if (!config.content.enabled || entry.namesOnly || entry.offline || entry.size === 0) continue
    const ext = extOf(entry.name)
    const kind = kindOf(entry.name)
    if (!wantsContent(ext, kind, ocr, config.content.metadata) || secretFile(entry.path)) continue
    if (DOCUMENT_EXTS.has(ext)) { if (entry.size <= maxDoc) e.documents++ }
    else if (OCR_EXTS.has(ext) && kind === "image") { if (ocr && entry.size <= maxDoc) e.ocrImages++ }
    // Files of unknown types are mostly binary, which a look at their first 8 KB rules out.
    else if (entry.size <= maxText) { e.textFiles++; e.textBytes += kind === "other" ? Math.min(entry.size, 8192) : entry.size }
  }
  const workers = config.workers > 0 ? config.workers : defaultWorkers(loadShare(config.indexLoad))
  e.seconds = firstPassSeconds(e, workers)
  return e
}

/** The estimates of several folders as one. */
export function combine(estimates: FolderEstimate[], root = estimates.map((e) => e.root).join(", ")): FolderEstimate {
  const out: FolderEstimate = { root, files: 0, folders: 0, textFiles: 0, textBytes: 0, documents: 0, ocrImages: 0, complete: true, seconds: 0 }
  for (const e of estimates) {
    out.files += e.files; out.folders += e.folders; out.textFiles += e.textFiles; out.textBytes += e.textBytes
    out.documents += e.documents; out.ocrImages += e.ocrImages; out.seconds += e.seconds
    out.complete &&= e.complete
  }
  return out
}

/** "about 2 minutes", rounded the way people say times they are not sure of. */
export function roughDuration(seconds: number): string {
  if (seconds < 60) return "under a minute"
  const min = Math.round(seconds / 60)
  if (min < 60) return min === 1 ? "about a minute" : `about ${min} minutes`
  const h = Math.round(seconds / 1800) / 2
  return h === 1 ? "about an hour" : `about ${h} hours`
}

/** "12,345 files · about 3 minutes", or a lower bound when the walk ran out of time. */
export function describeEstimate(e: FolderEstimate): string {
  if (e.complete) return `${formatCount(e.files)} files · ${roughDuration(e.seconds)}`
  return `over ${formatCount(e.files)} files · ${e.seconds < 60 ? "a minute or more" : `at least ${roughDuration(e.seconds).replace(/^about /, "")}`}`
}

/** The error `estimateInBackground` rejects with once cancelled. */
export const ESTIMATE_CANCELLED = "estimate cancelled"

/**
 * Estimate folders on a worker thread, so the walk never holds up the caller. Folders and the
 * home folder are resolved there. `cancel` stops it, and `done` rejects with `ESTIMATE_CANCELLED`.
 */
export function estimateInBackground(roots: string[], config: Config): { done: Promise<FolderEstimate[]>; cancel: () => void } {
  const worker = new Worker(workerUrl("index/estimate-worker.ts"))
  let fail: (err: Error) => void = () => {}
  const done = new Promise<FolderEstimate[]>((resolve, reject) => {
    fail = (err) => { worker.terminate(); reject(err) }
    worker.onmessage = (ev: MessageEvent<{ estimates?: FolderEstimate[]; error?: string }>) => {
      worker.terminate()
      if (ev.data.estimates) resolve(ev.data.estimates)
      else reject(new Error(ev.data.error ?? "estimate failed"))
    }
    worker.onerror = (ev) => {
      ev.preventDefault?.()
      fail(new Error((ev as ErrorEvent).message || "estimate failed"))
    }
  })
  worker.postMessage({ roots, config })
  return { done, cancel: () => fail(new Error(ESTIMATE_CANCELLED)) }
}

/** The estimates for these folders, one after another (the worker's job). */
export function estimateFolders(roots: string[], config: Config): FolderEstimate[] {
  return roots.map((root) => ({ ...estimateFolder(resolvePath(root), config), root }))
}
