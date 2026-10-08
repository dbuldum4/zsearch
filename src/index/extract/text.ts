import { htmlText, tidy } from "./xml.ts"

/** Heuristic binary detection on the first bytes of a file. */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192)
  if (n === 0) return false
  if (hasUtf16Bom(buf)) return false
  let control = 0
  for (let i = 0; i < n; i++) {
    const b = buf[i]!
    if (b === 0) return true
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) control++
  }
  return control / n > 0.1
}

function hasUtf16Bom(buf: Uint8Array): boolean {
  return buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
}

const utf8 = new TextDecoder("utf-8", { fatal: true })
const utf8Lenient = new TextDecoder("utf-8")
let win1252: TextDecoder | null = null

/** Decode bytes as text: BOMs, UTF-8, falling back to Windows-1252. */
export function decodeText(buf: Uint8Array): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return utf8Lenient.decode(buf.subarray(3))
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2))
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2))
  try {
    return utf8.decode(buf)
  } catch {
    // Mostly-UTF-8 files with a few bad bytes stay UTF-8; otherwise assume a legacy single-byte encoding.
    const lenient = utf8Lenient.decode(buf)
    let bad = 0
    for (let i = 0; i < lenient.length; i++) if (lenient.charCodeAt(i) === 0xfffd) bad++
    if (bad / Math.max(1, lenient.length) < 0.01) return lenient
    try {
      win1252 ??= new TextDecoder("windows-1252")
      return win1252.decode(buf)
    } catch {
      return lenient
    }
  }
}

/** Jupyter notebook: markdown and code cells in order. */
export function extractNotebook(src: string): string {
  const nb = JSON.parse(src) as { cells?: { cell_type?: string; source?: string | string[] }[]; worksheets?: { cells?: { input?: string | string[]; source?: string | string[] }[] }[] }
  const cells = nb.cells ?? nb.worksheets?.flatMap((w) => w.cells ?? []) ?? []
  const parts: string[] = []
  for (const c of cells as { source?: string | string[]; input?: string | string[] }[]) {
    const s = c.source ?? c.input ?? ""
    parts.push(Array.isArray(s) ? s.join("") : s)
  }
  return tidy(parts.join("\n\n"))
}

/* ------------------------------------------------------------------ email -- */

function decodeQuotedPrintable(s: string): Uint8Array {
  const bytes: number[] = []
  const src = s.replace(/=\r?\n/g, "")
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      const code = src.charCodeAt(i)
      if (code < 0x80) bytes.push(code)
      else for (const b of new TextEncoder().encode(c)) bytes.push(b)
    }
  }
  return new Uint8Array(bytes)
}

function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const cs = (charset || "utf-8").toLowerCase()
  try {
    return new TextDecoder((cs === "us-ascii" ? "utf-8" : cs) as never).decode(bytes)
  } catch {
    return decodeText(bytes)
  }
}

/** RFC 2047 encoded words in headers. */
function decodeHeader(v: string): string {
  return v
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs: string, enc: string, data: string) => {
      const bytes = enc.toUpperCase() === "B" ? Uint8Array.from(Buffer.from(data, "base64")) : decodeQuotedPrintable(data.replace(/_/g, " "))
      return decodeCharset(bytes, cs)
    })
}

interface Part {
  headers: Map<string, string>
  body: string
}

function splitPart(raw: string): Part {
  const idx = raw.search(/\r?\n\r?\n/)
  const head = idx >= 0 ? raw.slice(0, idx) : raw
  const body = idx >= 0 ? raw.slice(idx).replace(/^\r?\n\r?\n/, "") : ""
  const headers = new Map<string, string>()
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const c = line.indexOf(":")
    if (c > 0) headers.set(line.slice(0, c).trim().toLowerCase(), line.slice(c + 1).trim())
  }
  return { headers, body }
}

function param(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(header)
  return m ? (m[1] ?? m[2]) : undefined
}

function partText(part: Part, depth = 0): string {
  const ctype = part.headers.get("content-type") ?? "text/plain"
  const mime = ctype.split(";")[0]!.trim().toLowerCase()
  if (mime.startsWith("multipart/") && depth < 8) {
    const boundary = param(ctype, "boundary")
    if (!boundary) return ""
    const pieces = part.body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\s*\\r?\\n`))
    const subs = pieces.slice(1).map((p) => splitPart(p))
    if (mime === "multipart/alternative") {
      const plain = subs.find((s) => (s.headers.get("content-type") ?? "text/plain").toLowerCase().startsWith("text/plain"))
      const chosen = plain ?? subs[subs.length - 1]
      return chosen ? partText(chosen, depth + 1) : ""
    }
    return subs
      .map((s) => partText(s, depth + 1))
      .filter(Boolean)
      .join("\n\n")
  }
  if (!mime.startsWith("text/") && mime !== "message/rfc822") return ""
  if (/attachment/i.test(part.headers.get("content-disposition") ?? "") && !mime.startsWith("text/plain")) return ""
  const enc = (part.headers.get("content-transfer-encoding") ?? "").toLowerCase()
  let bytes: Uint8Array
  if (enc === "base64") bytes = Uint8Array.from(Buffer.from(part.body.replace(/\s+/g, ""), "base64"))
  else if (enc === "quoted-printable") bytes = decodeQuotedPrintable(part.body)
  else bytes = new TextEncoder().encode(part.body)
  const text = decodeCharset(bytes, param(ctype, "charset"))
  return mime === "text/html" ? htmlText(text) : text
}

/** Headers (subject, from, to, date) followed by the readable body. */
export function extractEmail(src: string): string {
  // Apple Mail .emlx starts with a byte count line.
  const raw = /^\d+\s*\n/.test(src) ? src.replace(/^\d+\s*\n/, "") : src
  const part = splitPart(raw)
  const lines: string[] = []
  for (const h of ["subject", "from", "to", "cc", "date"]) {
    const v = part.headers.get(h)
    if (v) lines.push(`${h[0]!.toUpperCase()}${h.slice(1)}: ${decodeHeader(v)}`)
  }
  return tidy(`${lines.join("\n")}\n\n${partText(part)}`)
}
