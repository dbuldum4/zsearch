import { closeSync, openSync, readFileSync, readSync } from "node:fs"
import { DOCUMENT_EXTS, TEXTUAL_KINDS, type Kind } from "../../kinds.ts"
import { binaryStrings, extractDoc, extractPpt, extractRtf, extractXls, isOle2 } from "./legacy.ts"
import { extractDocx, extractEpub, extractFlatOdf, extractOdf, extractPptx, extractXlsx } from "./office.ts"
import { extractPdf } from "./pdf.ts"
import { decodeText, extractEmail, extractNotebook, looksBinary } from "./text.ts"
import { htmlText } from "./xml.ts"
import { ZipReader } from "./zip.ts"

export interface ExtractOptions {
  maxTextBytes: number
  maxDocBytes: number
  maxChars: number
  pdfTimeoutMs?: number
}

export const DEFAULT_EXTRACT: ExtractOptions = {
  maxTextBytes: 8 * 1024 * 1024,
  maxDocBytes: 64 * 1024 * 1024,
  maxChars: 2_000_000,
  pdfTimeoutMs: 60_000,
}

export type ExtractResult =
  | { status: "ok"; text: string; truncated: boolean }
  | { status: "skip"; reason: "binary" | "too-large" | "unsupported" | "empty" }

/** As `ExtractResult`, but a plain text file comes as its bytes: decode them with `textOf`. */
export type RawExtractResult = ExtractResult | { status: "bytes"; bytes: Uint8Array }

/** Does this file get its contents read at all? */
export function wantsContent(ext: string, kind: Kind): boolean {
  return DOCUMENT_EXTS.has(ext) || TEXTUAL_KINDS.has(kind) || kind === "other" || ext === "mbox"
}

// Files are read synchronously: extraction runs on worker threads, where blocking is fine, and
// an asynchronous read of a small file costs several times as much as the read itself.
async function readFile(path: string): Promise<Uint8Array> {
  const b = readFileSync(path)
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
}

async function readHead(path: string, n: number): Promise<Uint8Array> {
  const fd = openSync(path, "r")
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
export async function extractRaw(path: string, size: number, ext: string, kind: Kind, opts: ExtractOptions = DEFAULT_EXTRACT): Promise<RawExtractResult> {
  if (DOCUMENT_EXTS.has(ext)) {
    if (size > opts.maxDocBytes) return { status: "skip", reason: "too-large" }
    if (size === 0) return { status: "skip", reason: "empty" }
    return finish(await extractDocument(path, ext, opts), opts.maxChars)
  }
  if (!wantsContent(ext, kind)) return { status: "skip", reason: "unsupported" }
  if (size > opts.maxTextBytes) return { status: "skip", reason: "too-large" }
  if (size === 0) return { status: "skip", reason: "empty" }
  // Unknown file types: sniff before reading the whole thing.
  if (kind === "other" && size > 8192) {
    if (looksBinary(await readHead(path, 8192))) return { status: "skip", reason: "binary" }
  }
  const buf = await readFile(path)
  if (looksBinary(buf)) return { status: "skip", reason: "binary" }
  return { status: "bytes", bytes: buf }
}

async function extractDocument(path: string, ext: string, opts: ExtractOptions): Promise<string> {
  if (ext === "pdf") return extractPdf(path, () => readFile(path), opts.pdfTimeoutMs)
  const buf = await readFile(path)
  switch (ext) {
    case "docx":
    case "docm":
    case "dotx":
      return ooxml(buf, extractDocx)
    case "xlsx":
    case "xlsm":
    case "xltx":
      return ooxml(buf, (b) => extractXlsx(b, opts.maxChars))
    case "pptx":
    case "pptm":
    case "ppsx":
    case "potx":
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
    case "rtf":
      return extractRtf(decodeText(buf))
    case "doc":
    case "xls":
    case "ppt":
      return legacy(buf, ext)
    case "eml":
    case "emlx":
      return extractEmail(decodeText(buf))
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

function legacy(buf: Uint8Array, ext: string): string {
  if (isOle2(buf)) {
    try {
      if (ext === "doc") return extractDoc(buf)
      if (ext === "xls") return extractXls(buf)
      return extractPpt(buf)
    } catch (err) {
      if ((err as Error).message.includes("encrypted")) throw err
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
