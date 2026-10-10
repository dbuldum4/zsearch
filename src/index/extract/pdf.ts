import { pdftotextPath } from "../../platform.ts"
import { ocrBlankPages } from "./ocr.ts"
import { tidy } from "./xml.ts"

/**
 * Text of a PDF with pages separated by form feeds. Uses poppler's pdftotext when available.
 * With an OCR helper, pages without text (scans) are read with OCR.
 */
export async function extractPdf(path: string, buf: () => Promise<Uint8Array>, timeoutMs = 60_000, ocrTool?: string | null): Promise<string> {
  const text = await pdfText(path, buf, timeoutMs)
  return ocrTool ? ocrBlankPages(ocrTool, path, text, timeoutMs) : text
}

async function pdfText(path: string, buf: () => Promise<Uint8Array>, timeoutMs: number): Promise<string> {
  const tool = pdftotextPath()
  if (tool) {
    try {
      return await viaPdftotext(tool, path, timeoutMs)
    } catch (err) {
      // Fall through to the JavaScript implementation (handles some files poppler rejects).
      if ((err as Error).message.includes("timed out")) throw err
    }
  }
  return viaPdfjs(await buf(), timeoutMs)
}

async function viaPdftotext(tool: string, path: string, timeoutMs: number): Promise<string> {
  // pdftotext separates pages with \f, which the UI uses to show page numbers.
  const p = Bun.spawn([tool, "-enc", "UTF-8", "-q", path, "-"], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => p.kill(), timeoutMs)
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    if (p.signalCode) throw new Error(`pdftotext timed out after ${timeoutMs / 1000}s`)
    if (code !== 0) throw new Error(`pdftotext failed (${code}): ${err.trim().slice(0, 200)}`)
    return tidy(out)
  } finally {
    clearTimeout(timer)
  }
}

let pdfjsLoad: Promise<typeof import("unpdf")> | null = null

async function viaPdfjs(data: Uint8Array, timeoutMs: number): Promise<string> {
  pdfjsLoad ??= import("unpdf")
  const { extractText, getDocumentProxy } = await pdfjsLoad
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`PDF parsing timed out after ${timeoutMs / 1000}s`)), timeoutMs)
  })
  try {
    const work = (async () => {
      // pdf.js detaches the buffer it is given, so hand it a copy.
      const doc = await getDocumentProxy(new Uint8Array(data), { verbosity: 0, isEvalSupported: false } as never)
      try {
        const { text } = await extractText(doc, { mergePages: false })
        return tidy((text as string[]).map((t) => t.trim()).join("\f"))
      } finally {
        await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => {})
      }
    })()
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}
