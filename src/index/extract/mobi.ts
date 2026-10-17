import { htmlText } from "./xml.ts"

const MAX_TEXT_BYTES = 32 << 20

/** MOBI 6 text, including the MOBI 6 half of dual-format books. No DRM or HUFF/CDIC.
 * Format reference: https://github.com/kovidgoyal/calibre/blob/master/format_docs/pdb/mobi.txt
 */
export function extractMobi(buf: Uint8Array): string {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const ascii = (start: number, end: number) => new TextDecoder().decode(buf.subarray(start, end))
  if (buf.length < 78 || ascii(60, 68) !== "BOOKMOBI") throw new Error("not a MOBI book")
  const count = view.getUint16(76)
  const tableEnd = 78 + count * 8
  if (count < 2 || tableEnd > buf.length) throw new Error("corrupt MOBI record table")
  const offsets: number[] = []
  for (let i = 0; i < count; i++) {
    const offset = view.getUint32(78 + i * 8)
    if (offset < tableEnd || offset >= buf.length || (i > 0 && offset <= offsets[i - 1]!)) throw new Error("corrupt MOBI record offset")
    offsets.push(offset)
  }
  offsets.push(buf.length)
  const start = offsets[0]!, headerSize = offsets[1]! - start
  if (headerSize < 40 || ascii(start + 16, start + 20) !== "MOBI") throw new Error("missing MOBI header")
  const compression = view.getUint16(start)
  const textLength = view.getUint32(start + 4)
  const records = view.getUint16(start + 8)
  const recordSize = view.getUint16(start + 10)
  if (view.getUint16(start + 12) !== 0) throw new Error("MOBI book is encrypted")
  if (compression !== 1 && compression !== 2) throw new Error("unsupported MOBI compression (HUFF/CDIC)")
  const mobiSize = view.getUint32(start + 20)
  if (mobiSize < 24 || mobiSize + 16 > headerSize) throw new Error("corrupt MOBI header length")
  if (view.getUint32(start + 36) >= 8) throw new Error("unsupported MOBI format (KF8)")
  const encoding = view.getUint32(start + 28)
  if (encoding !== 1252 && encoding !== 65001) throw new Error("unsupported MOBI text encoding")
  if (textLength > MAX_TEXT_BYTES) throw new Error("MOBI text exceeds size budget")
  if (records >= count || !recordSize || textLength > records * recordSize) throw new Error("corrupt MOBI text records")
  const flags = mobiSize >= 228 ? view.getUint16(start + 242) : 0
  const text = new Uint8Array(textLength)
  let written = 0, expanded = 0
  for (let i = 1; i <= records; i++) {
    const record = stripExtras(buf.subarray(offsets[i]!, offsets[i + 1]!), flags)
    const decoded = compression === 1 ? record : palmDoc(record, recordSize)
    if (decoded.length > recordSize) throw new Error("MOBI record exceeds size budget")
    expanded += decoded.length
    if (expanded > MAX_TEXT_BYTES) throw new Error("MOBI text exceeds size budget")
    const chunk = decoded.subarray(0, textLength - written)
    text.set(chunk, written)
    written += chunk.length
  }
  if (written !== textLength) throw new Error("truncated MOBI text")
  const html = new TextDecoder(encoding === 65001 ? "utf-8" : "windows-1252").decode(text)
  // Stop at the next tag opener too: unfinished tags must not rescan the remaining book.
  return htmlText(html.replace(/<mbp:pagebreak\b[^<>]*>/gi, "\f"))
}

/** Trailing metadata is outside the compressed stream; bit zero adds UTF-8 overlap bytes. */
function stripExtras(record: Uint8Array, flags: number): Uint8Array {
  let end = record.length
  for (let bits = flags >>> 1; bits; bits >>>= 1) {
    if (!(bits & 1)) continue
    let size = 0, bytes = 0, done = false
    for (; bytes < 4 && bytes < end; bytes++) {
      const b = record[end - 1 - bytes]!
      size += (b & 0x7f) * 2 ** (bytes * 7)
      if (b & 0x80) { bytes++; done = true; break }
    }
    if (!done || size < bytes || size > end) throw new Error("corrupt MOBI trailing data")
    end -= size
  }
  if (flags & 1) {
    if (!end) throw new Error("missing MOBI overlap data")
    const size = (record[end - 1]! & 3) + 1
    if (size > end) throw new Error("corrupt MOBI overlap data")
    end -= size
  }
  return record.subarray(0, end)
}

function palmDoc(input: Uint8Array, limit: number): Uint8Array {
  const out = new Uint8Array(limit)
  let size = 0
  const push = (b: number) => {
    if (size === limit) throw new Error("MOBI record exceeds size budget")
    out[size++] = b
  }
  for (let i = 0; i < input.length;) {
    const b = input[i++]!
    if (b >= 1 && b <= 8) {
      if (i + b > input.length) throw new Error("truncated PalmDOC literals")
      for (let n = 0; n < b; n++) push(input[i++]!)
    } else if (b >= 0x80 && b <= 0xbf) {
      if (i === input.length) throw new Error("truncated PalmDOC reference")
      const pair = ((b & 0x3f) << 8) | input[i++]!
      const distance = pair >>> 3, length = (pair & 7) + 3
      if (!distance || distance > size) throw new Error("invalid PalmDOC reference")
      for (let n = 0; n < length; n++) push(out[size - distance]!)
    } else if (b >= 0xc0) {
      push(32); push(b ^ 0x80)
    } else push(b)
  }
  return out.subarray(0, size)
}
