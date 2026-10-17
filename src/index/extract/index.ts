import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs"
import { constants } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathPolicy } from "../policy.ts"
import type { CrawlOptions } from "../crawler.ts"
import { bytesHoldPrivateKey, notKeynote, onlyKeys, redactPrivateKeys, SECRET_NOTE } from "../secrets.ts"
import { DOCUMENT_EXTS, OCR_EXTS, TEXT_EXPORT_EXTS, TEXTUAL_KINDS, TRANSCRIBE_EXTS, type Kind } from "../../kinds.ts"
import { transcribe } from "./transcribe.ts"
import { extractPim } from "./pim.ts"
import { binaryStrings, extractDoc, extractPpt, extractRtf, extractXls, isOle2 } from "./legacy.ts"
import { extractDocx, extractEpub, extractFlatOdf, extractOdf, extractPptx, extractXlsx } from "./office.ts"
import { ocrImage, type OcrMemo } from "./ocr.ts"
import { extractPdf, extractPdfBytes } from "./pdf.ts"
import { decodeText, extractEmail, extractNotebook, looksBinary } from "./text.ts"
import { htmlText } from "./xml.ts"
import { ZipReader } from "./zip.ts"
import { extractMobi } from "./mobi.ts"

export interface ExtractOptions {
  maxTextBytes: number
  maxDocBytes: number
  maxChars: number
  pdfTimeoutMs?: number
  fileTimeoutMs?: number
  policy?: CrawlOptions
  contentEnabled?: boolean
  metadata?: boolean
  /** The OCR helper, when images and scanned pages are to be read (see `ocrToolPath`). */
  ocrTool?: string | null
  transcriptionTool?: string | null
  transcriptionLocale?: string
  transcriptionRun?: string
}

export const DEFAULT_EXTRACT: ExtractOptions = {
  maxTextBytes: 8 * 1024 * 1024,
  maxDocBytes: 64 * 1024 * 1024,
  maxChars: 2_000_000,
  pdfTimeoutMs: 60_000,
}

type ExtractResult =
  | { status: "ok"; text: string; truncated: boolean }
  | { status: "skip"; reason: "binary" | "too-large" | "unsupported" | "empty" | typeof SECRET_NOTE }

/** As `ExtractResult`, but a plain text file comes as its bytes: decode them with `textOf`. */
type RawExtractResult = ExtractResult | { status: "bytes"; bytes: Uint8Array }

/** Does this file get its contents read at all? Images only with `ocr`. */
export function wantsContent(ext: string, kind: Kind, ocr = false, metadata = false, speech = false): boolean {
  return DOCUMENT_EXTS.has(ext) || TEXT_EXPORT_EXTS.has(ext) || TEXTUAL_KINDS.has(kind) || kind === "other" || (metadata && kind === "image") || ext === "mbox" || (ocr && OCR_EXTS.has(ext)) || (speech && TRANSCRIBE_EXTS.has(ext))
}

// Files are read synchronously: extraction runs on worker threads, where blocking is fine, and
// an asynchronous read of a small file costs several times as much as the read itself.
async function readFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const size = fstatSync(fd).size
    if (size > maxBytes) throw new Error("file exceeds extraction size budget")
    const b = new Uint8Array(size)
    let read = 0
    while (read < size) { const n = readSync(fd, b, read, size - read, read); if (!n) break; read += n }
    return b.subarray(0, read)
  } finally { closeSync(fd) }
}

async function readHead(path: string, n: number): Promise<Uint8Array> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buf = new Uint8Array(n)
    const bytesRead = readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

function finish(text: string, maxChars: number): ExtractResult {
  let t = text.indexOf("\0") >= 0 ? text.replace(/\0/g, "") : text
  if (t.indexOf("\r") >= 0) t = t.replace(/\r\n?/g, "\n")
  if (!t.trim()) return { status: "skip", reason: "empty" }
  if (t.length > maxChars) return { status: "ok", text: t.slice(0, maxChars), truncated: true }
  return { status: "ok", text: t, truncated: false }
}

/** Extract searchable text from a file. Throws on unreadable or corrupt documents. */
export async function extract(path: string, size: number, ext: string, kind: Kind, opts: ExtractOptions = DEFAULT_EXTRACT): Promise<ExtractResult> {
  const r = await extractRaw(path, size, ext, kind, opts)
  return r.status === "bytes" ? textOf(r.bytes, opts.maxChars) : r
}

/** The text of a plain text file's bytes. */
export function textOf(bytes: Uint8Array, maxChars: number): ExtractResult {
  return finish(decodeText(bytes), maxChars)
}

/** As `extract`, leaving plain text files undecoded. */
export async function extractRaw(path: string, size: number, ext: string, kind: Kind, opts: ExtractOptions = DEFAULT_EXTRACT, memo?: OcrMemo): Promise<RawExtractResult> {
  if (opts.contentEnabled === false) return { status: "skip", reason: "unsupported" }
  if (opts.policy) {
    const policy = pathPolicy(path, opts.policy)
    if (!policy.allowed || !policy.content) return { status: "skip", reason: "unsupported" }
    path = policy.real!
  }
  if (TRANSCRIBE_EXTS.has(ext)) {
    if (!opts.transcriptionTool) return { status: "skip", reason: "unsupported" }
    if (!size) return { status: "skip", reason: "empty" }
    // Media are streamed by AVFoundation, not loaded into memory or limited by document size.
    const r = await transcribe(opts.transcriptionTool, path, opts.transcriptionLocale ?? "", opts.maxChars, undefined, opts.transcriptionRun)
    const result = finish(r.text, opts.maxChars)
    return result.status === "ok" ? { ...result, truncated: result.truncated || r.truncated } : result
  }
  if (DOCUMENT_EXTS.has(ext)) {
    if (size > opts.maxDocBytes) return { status: "skip", reason: "too-large" }
    if (size === 0) return { status: "skip", reason: "empty" }
    if (ext === "key" && notKeynote(await readHead(path, 4))) return { status: "skip", reason: SECRET_NOTE }
    return finish(await extractDocument(path, ext, opts, memo), opts.maxChars)
  }
  if (OCR_EXTS.has(ext) && kind === "image") {
    if (!opts.ocrTool) return { status: "skip", reason: "unsupported" }
    if (size > opts.maxDocBytes) return { status: "skip", reason: "too-large" }
    if (size === 0) return { status: "skip", reason: "empty" }
    return finish(await ocrImage(opts.ocrTool, path, opts.pdfTimeoutMs ?? 60_000, memo), opts.maxChars)
  }
  if (!wantsContent(ext, kind)) return { status: "skip", reason: "unsupported" }
  if (size > opts.maxTextBytes) return { status: "skip", reason: "too-large" }
  if (size === 0) return { status: "skip", reason: "empty" }
  // Unknown file types: sniff before reading the whole thing.
  if (kind === "other" && size > 8192) {
    if (looksBinary(await readHead(path, 8192))) return { status: "skip", reason: "binary" }
  }
  const buf = await readFile(path, opts.maxTextBytes)
  if (looksBinary(buf)) return { status: "skip", reason: "binary" }
  if (TEXT_EXPORT_EXTS.has(ext)) return finish(extractPim(decodeText(buf), ext), opts.maxChars)
  if (bytesHoldPrivateKey(buf)) {
    // Keys are cut out of the text; a file that is all key is a key file.
    const text = redactPrivateKeys(decodeText(buf))
    return onlyKeys(text) ? { status: "skip", reason: SECRET_NOTE } : finish(text, opts.maxChars)
  }
  return { status: "bytes", bytes: buf }
}

async function extractDocument(path: string, ext: string, opts: ExtractOptions, memo?: OcrMemo): Promise<string> {
  if (ext === "pdf") return extractPdf(path, () => readFile(path, opts.maxDocBytes), opts.pdfTimeoutMs, opts.ocrTool, opts.metadata, memo)
  const buf = await readFile(path, opts.maxDocBytes)
  switch (ext) {
    case "pages":
    case "numbers":
    case "key": {
      if (!ZipReader.isZip(buf)) return ""
      const zip = new ZipReader(buf)
      const preview = zip.read("QuickLook/Preview.pdf") ?? zip.read("preview.pdf")
      if (preview) return extractPdfBytes(preview, opts.pdfTimeoutMs, opts.metadata)
      const image = opts.ocrTool ? zip.read("QuickLook/Preview.jpg") ?? zip.read("preview.jpg") ?? zip.read("QuickLook/Thumbnail.jpg") : null
      if (!image || !opts.ocrTool) return ""
      const scratch = mkdtempSync(join(tmpdir(), "zsearch-iwork-"))
      try {
        const imagePath = join(scratch, "preview.jpg")
        writeFileSync(imagePath, image, { mode: 0o600 })
        return await ocrImage(opts.ocrTool, imagePath, opts.pdfTimeoutMs ?? 60_000, memo)
      } finally { rmSync(scratch, { recursive: true, force: true }) }
    }
    case "docx":
    case "docm":
    case "dotx":
    case "dotm":
      return ooxml(buf, extractDocx)
    case "xlsx":
    case "xlsm":
    case "xltx":
    case "xltm":
      return ooxml(buf, (b) => extractXlsx(b, opts.maxChars))
    case "pptx":
    case "pptm":
    case "ppsx":
    case "potx":
    case "potm":
      return ooxml(buf, extractPptx)
    case "odt":
    case "ott":
    case "ods":
    case "ots":
    case "odp":
    case "otp":
      return extractOdf(buf)
    case "fodt":
    case "fods":
    case "fodp":
      return extractFlatOdf(decodeText(buf))
    case "epub":
      return extractEpub(buf, opts.maxChars)
    case "mobi":
      return extractMobi(buf)
    case "rtf":
      return extractRtf(decodeText(buf))
    case "doc":
    case "xls":
    case "ppt":
      return legacy(buf, ext, opts.maxChars)
    case "dot":
      return legacy(buf, "doc", opts.maxChars)
    case "xlt":
      return legacy(buf, "xls", opts.maxChars)
    case "pot":
    case "pps":
      return legacy(buf, "ppt", opts.maxChars)
    case "eml":
    case "emlx":
      return extractEmail(buf)
    case "ipynb":
      return extractNotebook(decodeText(buf))
    default:
      throw new Error(`no extractor for .${ext}`)
  }
}

function ooxml(buf: Uint8Array, fn: (b: Uint8Array) => string): string {
  if (ZipReader.isZip(buf)) return fn(buf)
  if (isOle2(buf)) throw new Error("document is password-protected")
  throw new Error("not a valid Office file")
}

function legacy(buf: Uint8Array, ext: string, maxChars: number): string {
  if (isOle2(buf)) {
    try {
      if (ext === "doc") return extractDoc(buf)
      if (ext === "xls") return extractXls(buf, maxChars)
      return extractPpt(buf)
    } catch (err) {
      if (/encrypted|corrupt piece table|size budget|allocation table|bad (?:mini )?sector size/.test((err as Error).message)) throw err
      return binaryStrings(buf)
    }
  }
  // Old "doc"/"xls" files are frequently RTF, HTML or plain text in disguise.
  if (ZipReader.isZip(buf)) return ext === "doc" ? extractDocx(buf) : ext === "xls" ? extractXlsx(buf) : extractPptx(buf)
  const head = decodeText(buf.subarray(0, 2048)).trimStart()
  if (head.startsWith("{\\rtf")) return extractRtf(decodeText(buf))
  if (/^<(!doctype|html|\?xml)/i.test(head)) return htmlText(decodeText(buf))
  if (!looksBinary(buf)) return decodeText(buf)
  return binaryStrings(buf)
}
