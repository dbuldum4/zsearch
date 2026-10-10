import { tidy } from "./xml.ts"

/** Scanned pages read at most per PDF: OCR takes a fraction of a second per page. */
export const OCR_MAX_PAGES = 100

/** Run the OCR helper (`zsearch-ocr`, see `ocrToolPath`) and return what it prints. */
async function runOcr(tool: string, args: string[], timeoutMs: number): Promise<string> {
  const p = Bun.spawn([tool, ...args], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => p.kill(), timeoutMs)
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    if (p.signalCode) throw new Error(`OCR timed out after ${timeoutMs / 1000}s`)
    if (code !== 0) throw new Error(`OCR failed (${code}): ${err.trim().slice(0, 200)}`)
    return out
  } finally {
    clearTimeout(timer)
  }
}

/** The text in an image. */
export async function ocrImage(tool: string, path: string, timeoutMs: number): Promise<string> {
  return tidy(await runOcr(tool, ["image", path], timeoutMs))
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
export async function ocrBlankPages(tool: string, path: string, text: string, timeoutMs: number): Promise<string> {
  const pages = text.split("\f")
  // Pages at the end without text leave no form feed behind, so the helper looks at every page
  // without text of its own, and returns all pages (empty where it did not read one).
  if (!pages.some(blankPage)) return text
  let read: string[]
  try {
    read = (await runOcr(tool, ["pdf", path, "--max-pages", String(OCR_MAX_PAGES)], timeoutMs)).split("\f")
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
