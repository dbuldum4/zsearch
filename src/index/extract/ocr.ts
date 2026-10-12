import { tidy } from "./xml.ts"
import { cappedText, trackProcess } from "../../util/process.ts"

/** Scanned pages read at most per PDF: OCR takes a fraction of a second per page. */
const OCR_MAX_PAGES = 100

/**
 * OCR results carried over from an earlier reading of the same file (see `ocr_cache`): `cached`
 * is what the helper printed then, if anything. `fresh` is set to what it prints now, when it
 * reads the whole file.
 */
export interface OcrMemo {
  cached?: string
  fresh?: string
}

/** What the OCR helper prints for these arguments: from `memo` if it has it. */
async function memoOcr(memo: OcrMemo | undefined, tool: string, args: string[], timeoutMs: number, partial = false): Promise<string> {
  if (memo?.cached !== undefined) return memo.cached
  const r = await runOcr(tool, args, timeoutMs, partial)
  if (memo && r.complete) memo.fresh = r.text
  return r.text
}

/** Run the OCR helper (`zsearch-ocr`, see `ocrToolPath`) and return what it prints, and whether that is all of it. */
async function runOcr(tool: string, args: string[], timeoutMs: number, partial = false): Promise<{ text: string; complete: boolean }> {
  const p = trackProcess(Bun.spawn([tool, ...args], { stdout: "pipe", stderr: "pipe" }))
  const timer = setTimeout(() => p.kill(), timeoutMs)
  try {
    const [out, err, code] = await Promise.all([cappedText(p.stdout, 8 * 1024 * 1024, () => p.kill()), cappedText(p.stderr, 8192, () => p.kill()), p.exited])
    if (p.signalCode && !(partial && out.includes("\f"))) throw new Error(`OCR timed out after ${timeoutMs / 1000}s`)
    if (p.signalCode && partial) return { text: out.slice(0, out.lastIndexOf("\f")), complete: false }
    if (code !== 0) throw new Error(`OCR failed (${code}): ${err.trim().slice(0, 200)}`)
    return { text: out, complete: true }
  } finally {
    clearTimeout(timer)
  }
}

/** The text in an image. */
export async function ocrImage(tool: string, path: string, timeoutMs: number, memo?: OcrMemo): Promise<string> {
  return tidy(await memoOcr(memo, tool, ["image", path], timeoutMs))
}

/** A page with next to no text: a scan, or a page of pictures. */
function blankPage(page: string): boolean {
  let n = 0
  for (const c of page) if (/[\p{L}\p{N}]/u.test(c) && ++n >= 3) return false
  return true
}

/**
 * Fill in the pages of a PDF's text that have no text of their own (scanned pages) with what
 * OCR reads on them. `text` has a form feed between pages; pages that already have text keep it.
 */
export async function ocrBlankPages(tool: string, path: string, text: string, timeoutMs: number, memo?: OcrMemo): Promise<string> {
  const pages = text.split("\f")
  // Pages at the end without text leave no form feed behind, so the helper looks at every page
  // without text of its own, and returns all pages (empty where it did not read one).
  if (!pages.some(blankPage)) return text
  let read: string[]
  try {
    read = (await memoOcr(memo, tool, ["pdf", path, "--max-pages", String(OCR_MAX_PAGES)], Math.min(540_000, Math.max(timeoutMs, OCR_MAX_PAGES * 5000)), true)).split("\f")
  } catch {
    // The text the PDF has is still worth keeping.
    return text
  }
  const n = Math.max(pages.length, read.length)
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const own = pages[i] ?? ""
    out.push(blankPage(own) && read[i]?.trim() ? read[i]!.trim() : own)
  }
  return tidy(out.join("\f"))
}
