/**
 * Legacy binary Office formats (Word 97-2003 .doc, Excel .xls, PowerPoint .ppt).
 * They live in OLE2 compound files; we read the streams and pull out text directly.
 */
import { tidy } from "./xml.ts"

const ENDOFCHAIN = 0xfffffffe
const FREESECT = 0xffffffff
const CP1252: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
  0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
}

export function cp1252(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let s = ""
  for (let i = start; i < end; i++) {
    const b = bytes[i]!
    s += b >= 0x80 && b <= 0x9f ? (CP1252[b] ?? "") : String.fromCharCode(b)
  }
  return s
}

function utf16le(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder("utf-16le").decode(bytes.subarray(start, end - ((end - start) & 1)))
}

export function isOle2(buf: Uint8Array): boolean {
  return buf.length >= 512 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0 && buf[4] === 0xa1 && buf[5] === 0xb1 && buf[6] === 0x1a && buf[7] === 0xe1
}

/** OLE2 / Compound File Binary reader. */
export class Cfb {
  private view: DataView
  private sectorSize: number
  private miniSectorSize: number
  private miniCutoff: number
  private fat: Uint32Array
  private miniFat: Uint32Array = new Uint32Array(0)
  private miniStream: Uint8Array = new Uint8Array(0)
  readonly streams = new Map<string, { start: number; size: number }>()

  constructor(private buf: Uint8Array) {
    if (!isOle2(buf)) throw new Error("not an OLE2 compound file")
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const v = this.view
    this.sectorSize = 1 << v.getUint16(0x1e, true)
    this.miniSectorSize = 1 << v.getUint16(0x20, true)
    if (this.sectorSize !== 512 && this.sectorSize !== 4096) throw new Error("bad sector size")
    this.miniCutoff = v.getUint32(0x38, true)
    const numFat = v.getUint32(0x2c, true)
    // DIFAT: 109 entries in the header, the rest chained through DIFAT sectors.
    const fatSectors: number[] = []
    for (let i = 0; i < 109 && fatSectors.length < numFat; i++) fatSectors.push(v.getUint32(0x4c + i * 4, true))
    let difat = v.getUint32(0x44, true)
    const perSector = this.sectorSize / 4
    let guard = 0
    while (difat !== ENDOFCHAIN && difat !== FREESECT && fatSectors.length < numFat && guard++ < 1 << 16) {
      const off = this.sectorOffset(difat)
      for (let i = 0; i < perSector - 1 && fatSectors.length < numFat; i++) fatSectors.push(v.getUint32(off + i * 4, true))
      difat = v.getUint32(off + (perSector - 1) * 4, true)
    }
    this.fat = new Uint32Array(fatSectors.length * perSector)
    fatSectors.forEach((s, i) => {
      const off = this.sectorOffset(s)
      for (let j = 0; j < perSector; j++) this.fat[i * perSector + j] = off + j * 4 + 4 <= buf.length ? v.getUint32(off + j * 4, true) : FREESECT
    })
    // Directory
    const dir = this.readChain(v.getUint32(0x30, true))
    const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
    let rootStart = 0
    let rootSize = 0
    for (let off = 0; off + 128 <= dir.length; off += 128) {
      const nameLen = dv.getUint16(off + 0x40, true)
      const type = dir[off + 0x42]
      if (type === 0 || nameLen < 2) continue
      const name = utf16le(dir, off, off + Math.min(64, nameLen) - 2)
      const start = dv.getUint32(off + 0x74, true)
      const size = dv.getUint32(off + 0x78, true)
      if (type === 5) {
        rootStart = start
        rootSize = size
      } else if (type === 2 && !this.streams.has(name)) {
        this.streams.set(name, { start, size })
      }
    }
    const miniFatStart = v.getUint32(0x3c, true)
    if (miniFatStart !== ENDOFCHAIN && miniFatStart !== FREESECT && rootSize > 0) {
      const mf = this.readChain(miniFatStart)
      this.miniFat = new Uint32Array(mf.buffer.slice(mf.byteOffset, mf.byteOffset + (mf.length & ~3)))
      this.miniStream = this.readChain(rootStart).subarray(0, rootSize)
    }
  }

  private sectorOffset(sector: number): number {
    return (sector + 1) * this.sectorSize
  }

  private readChain(start: number, maxBytes = Infinity): Uint8Array {
    const parts: Uint8Array[] = []
    let total = 0
    let s = start
    const seen = new Set<number>()
    while (s !== ENDOFCHAIN && s !== FREESECT && s < this.fat.length && !seen.has(s) && total < maxBytes) {
      seen.add(s)
      const off = this.sectorOffset(s)
      if (off >= this.buf.length) break
      const chunk = this.buf.subarray(off, Math.min(off + this.sectorSize, this.buf.length))
      parts.push(chunk)
      total += chunk.length
      s = this.fat[s]!
    }
    return concat(parts, total)
  }

  private readMiniChain(start: number, size: number): Uint8Array {
    const out = new Uint8Array(size)
    let s = start
    let pos = 0
    const seen = new Set<number>()
    while (pos < size && s !== ENDOFCHAIN && s < this.miniFat.length && !seen.has(s)) {
      seen.add(s)
      const off = s * this.miniSectorSize
      const n = Math.min(this.miniSectorSize, size - pos)
      out.set(this.miniStream.subarray(off, off + n), pos)
      pos += n
      s = this.miniFat[s]!
    }
    return out.subarray(0, pos)
  }

  read(name: string): Uint8Array | null {
    const e = this.streams.get(name)
    if (!e) return null
    if (e.size < this.miniCutoff) return this.readMiniChain(e.start, e.size)
    return this.readChain(e.start, e.size).subarray(0, e.size)
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/* ------------------------------------------------------------------ .doc -- */

export function extractDoc(buf: Uint8Array): string {
  const cfb = new Cfb(buf)
  const wd = cfb.read("WordDocument")
  if (!wd || wd.length < 0x200) throw new Error("not a Word document (no WordDocument stream)")
  const v = new DataView(wd.buffer, wd.byteOffset, wd.byteLength)
  if (v.getUint16(0, true) !== 0xa5ec) throw new Error("unrecognised Word file")
  const flags = v.getUint16(0x0a, true)
  if (flags & 0x0100) throw new Error("document is encrypted")
  const table = cfb.read(flags & 0x0200 ? "1Table" : "0Table")
  // FibBase(32) | csw | fibRgW | cslw | fibRgLw | cbRgFcLcb | fibRgFcLcb
  let off = 32
  const csw = v.getUint16(off, true)
  off += 2 + csw * 2
  const cslw = v.getUint16(off, true)
  const rgLw = off + 2
  const ccpText = v.getInt32(rgLw + 3 * 4, true)
  const ccpTotal = Array.from({ length: 8 }, (_, i) => v.getInt32(rgLw + (3 + i) * 4, true)).reduce((a, b) => a + Math.max(0, b), 0)
  off = rgLw + cslw * 4
  const fcLcb = off + 2
  const fcClx = v.getUint32(fcLcb + 33 * 8, true)
  const lcbClx = v.getUint32(fcLcb + 33 * 8 + 4, true)
  let text = ""
  if (table && lcbClx > 0 && fcClx + lcbClx <= table.length) {
    text = piecesText(wd, table.subarray(fcClx, fcClx + lcbClx), Math.max(ccpText, ccpTotal))
  } else {
    // Non-complex file without a piece table: text starts at fcMin, 8-bit.
    const fcMin = v.getUint32(0x18, true)
    text = cp1252(wd, fcMin, Math.min(wd.length, fcMin + Math.max(0, ccpText)))
  }
  return cleanWordText(text)
}

function piecesText(wd: Uint8Array, clx: Uint8Array, maxCp: number): string {
  const v = new DataView(clx.buffer, clx.byteOffset, clx.byteLength)
  let i = 0
  while (i < clx.length && clx[i] === 0x01) i += 3 + v.getInt16(i + 1, true)
  if (clx[i] !== 0x02) throw new Error("corrupt piece table")
  const lcb = v.getUint32(i + 1, true)
  const plc = i + 5
  const n = Math.floor((lcb - 4) / 12)
  const out: string[] = []
  for (let k = 0; k < n; k++) {
    const cpStart = v.getUint32(plc + k * 4, true)
    const cpEnd = v.getUint32(plc + (k + 1) * 4, true)
    if (cpStart >= maxCp) break
    const len = Math.min(cpEnd, maxCp) - cpStart
    if (len <= 0) continue
    const pcd = plc + (n + 1) * 4 + k * 8
    const fcRaw = v.getUint32(pcd + 2, true)
    const compressed = (fcRaw & 0x40000000) !== 0
    const fc = fcRaw & 0x3fffffff
    if (compressed) out.push(cp1252(wd, fc / 2, Math.min(wd.length, fc / 2 + len)))
    else out.push(utf16le(wd, fc, Math.min(wd.length, fc + len * 2)))
  }
  return out.join("")
}

function cleanWordText(s: string): string {
  let out = ""
  let fieldDepth = 0
  let inCode: boolean[] = []
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    if (c === 0x13) {
      fieldDepth++
      inCode.push(true)
      continue
    }
    if (c === 0x14) {
      if (inCode.length) inCode[inCode.length - 1] = false
      continue
    }
    if (c === 0x15) {
      fieldDepth = Math.max(0, fieldDepth - 1)
      inCode.pop()
      continue
    }
    if (inCode.some(Boolean)) continue
    if (c === 0x0d || c === 0x0b) out += "\n"
    else if (c === 0x07) out += "\t"
    else if (c === 0x0c) out += "\n"
    else if (c === 0x1e) out += "-"
    else if (c === 0x09 || c === 0x0a) out += ch
    else if (c < 0x20 || c === 0x1f) continue
    else out += ch
  }
  return tidy(out.replace(/\t\n/g, "\n"))
}

/* ------------------------------------------------------------------ .xls -- */

/** Text of a BIFF8 workbook: sheet names, shared strings and numeric cells. */
export function extractXls(buf: Uint8Array): string {
  const cfb = new Cfb(buf)
  const wb = cfb.read("Workbook") ?? cfb.read("Book")
  if (!wb) throw new Error("not an Excel workbook (no Workbook stream)")
  const v = new DataView(wb.buffer, wb.byteOffset, wb.byteLength)
  const records: { type: number; data: Uint8Array }[] = []
  for (let off = 0; off + 4 <= wb.length; ) {
    const type = v.getUint16(off, true)
    const len = v.getUint16(off + 2, true)
    records.push({ type, data: wb.subarray(off + 4, Math.min(wb.length, off + 4 + len)) })
    off += 4 + len
  }
  const sheetNames: string[] = []
  let sst: string[] = []
  const cells: string[][] = []
  let sheet = -1
  let lastRow = -1
  const push = (row: number, value: string) => {
    if (!value) return
    const list = cells[sheet]!
    if (lastRow >= 0 && row !== lastRow) list.push("\n")
    else if (list.length) list.push("\t")
    list.push(value.replace(/[\t\n\r]+/g, " "))
    lastRow = row
  }
  for (let r = 0; r < records.length; r++) {
    const { type, data } = records[r]!
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    if (type === 0x0085 && data.length > 8) {
      // BOUNDSHEET
      const len = data[6]!
      const f = data[7]!
      sheetNames.push(f & 1 ? utf16le(data, 8, 8 + len * 2) : cp1252(data, 8, 8 + len))
    } else if (type === 0x00fc) {
      const parts = [data]
      while (records[r + 1]?.type === 0x003c) parts.push(records[++r]!.data)
      sst = parseSst(parts)
    } else if (type === 0x0809 && data.length >= 4 && dv.getUint16(2, true) === 0x0010) {
      // BOF of a worksheet
      sheet++
      cells[sheet] = []
      lastRow = -1
    } else if (sheet >= 0 && data.length >= 6) {
      const row = dv.getUint16(0, true)
      if (type === 0x00fd && data.length >= 10) push(row, sst[dv.getUint32(6, true)] ?? "")
      else if (type === 0x0203 && data.length >= 14) push(row, fmtNum(dv.getFloat64(6, true)))
      else if (type === 0x027e && data.length >= 10) push(row, fmtNum(rk(dv.getUint32(6, true))))
      else if (type === 0x0204 && data.length >= 8) {
        const len = dv.getUint16(6, true)
        const f = data[8]
        push(row, f === 1 ? utf16le(data, 9, 9 + len * 2) : cp1252(data, 9, 9 + len))
      }
    }
  }
  const out = cells.map((c, i) => `${sheetNames[i] ?? `Sheet${i + 1}`}\n${c.join("")}`)
  if (out.length === 0) return tidy(sst.join("\n"))
  return tidy(out.join("\f"))
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return ""
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e10) / 1e10)
}

function rk(v: number): number {
  let n: number
  if (v & 2) n = v >> 2
  else {
    // RK stores the high 30 bits of an IEEE double.
    const buf = new DataView(new ArrayBuffer(8))
    buf.setUint32(0, 0, true)
    buf.setUint32(4, v & 0xfffffffc, true)
    n = buf.getFloat64(0, true)
  }
  return v & 1 ? n / 100 : n
}

/** Shared string table, honouring CONTINUE records that split strings. */
function parseSst(parts: Uint8Array[]): string[] {
  const out: string[] = []
  let pi = 0
  let data = parts[0]!
  let pos = 8
  const total = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, true)
  const next = () => {
    pi++
    data = parts[pi]!
    pos = 0
    return data !== undefined
  }
  const u8 = () => {
    if (pos >= data.length && !next()) throw new Error("eof")
    return data[pos++]!
  }
  const u16 = () => u8() | (u8() << 8)
  const u32 = () => (u16() | (u16() << 16)) >>> 0
  try {
    for (let n = 0; n < total; n++) {
      if (pos >= data.length && !next()) break
      const cch = u16()
      let flags = u8()
      const rich = flags & 0x08 ? u16() : 0
      const ext = flags & 0x04 ? u32() : 0
      let s = ""
      let remaining = cch
      while (remaining > 0) {
        if (pos >= data.length) {
          if (!next()) break
          flags = u8() // continuation restates the 16-bit flag
        }
        const wide = flags & 1
        const avail = wide ? Math.floor((data.length - pos) / 2) : data.length - pos
        const take = Math.min(avail, remaining)
        s += wide ? utf16le(data, pos, pos + take * 2) : cp1252(data, pos, pos + take)
        pos += wide ? take * 2 : take
        remaining -= take
        if (take === 0 && !next()) break
      }
      for (let i = 0; i < rich * 4 + ext; i++) u8()
      out.push(s)
    }
  } catch {
    // truncated table: keep what we have
  }
  return out
}

/* ------------------------------------------------------------------ .ppt -- */

export function extractPpt(buf: Uint8Array): string {
  const cfb = new Cfb(buf)
  const doc = cfb.read("PowerPoint Document")
  if (!doc) throw new Error("not a PowerPoint file")
  const v = new DataView(doc.buffer, doc.byteOffset, doc.byteLength)
  const out: string[] = []
  const walk = (start: number, end: number, depth: number) => {
    let off = start
    while (off + 8 <= end) {
      const verInst = v.getUint16(off, true)
      const type = v.getUint16(off + 2, true)
      const len = v.getUint32(off + 4, true)
      const body = off + 8
      const stop = Math.min(end, body + len)
      if ((verInst & 0xf) === 0xf && depth < 32) {
        // Skip master slides (placeholder boilerplate like "Click to edit Master title style").
        if (type !== 0x03f8 && type !== 0x0fd9 && !(type === 0x0ff0 && verInst >> 4 === 1)) {
          if (type === 0x03ee) out.push("\f") // Slide container
          walk(body, stop, depth + 1)
        }
      } else if (type === 0x0fa0) out.push(utf16le(doc, body, stop) + "\n")
      else if (type === 0x0fa8) out.push(cp1252(doc, body, stop) + "\n")
      off = stop
    }
  }
  walk(0, doc.length, 0)
  // Text appears both in the slide list and in each slide's drawing: keep the first copy of each paragraph.
  const seen = new Set<string>()
  const lines: string[] = []
  for (const line of out.join("").replace(/\r/g, "\n").replace(/\x0b/g, "\n").split("\n")) {
    const key = line.replace(/\f/g, "").trim()
    if (key && (seen.has(key) || key === "*")) {
      if (line.includes("\f")) lines.push("\f")
      continue
    }
    seen.add(key)
    lines.push(line)
  }
  return tidy(lines.join("\n"))
}

/* ---------------------------------------------------------------- strings -- */

/** Last resort: printable runs of 8-bit and UTF-16LE text. */
export function binaryStrings(buf: Uint8Array, minLen = 5, maxChars = 1_000_000): string {
  const out: string[] = []
  let total = 0
  let run = ""
  const flush = () => {
    if (run.length >= minLen && /[A-Za-zÀ-ɏ]{3}/.test(run)) {
      out.push(run.trim())
      total += run.length
    }
    run = ""
  }
  for (let i = 0; i < buf.length && total < maxChars; i++) {
    const b = buf[i]!
    if ((b >= 0x20 && b < 0x7f) || b === 0x09) run += String.fromCharCode(b)
    else flush()
  }
  flush()
  for (let i = 0; i + 1 < buf.length && total < maxChars; i += 2) {
    const c = buf[i]! | (buf[i + 1]! << 8)
    if ((c >= 0x20 && c < 0xd800 && c !== 0x7f) || c === 0x09) run += String.fromCharCode(c)
    else flush()
  }
  flush()
  return tidy(out.join("\n"))
}

/* ------------------------------------------------------------------- RTF -- */

const RTF_SKIP_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "themedata", "colorschememapping", "latentstyles",
  "datastore", "xmlnstbl", "listtable", "listoverridetable", "rsidtbl", "generator", "filetbl", "revtbl", "pgdsctbl",
  "header", "footer", "headerl", "headerr", "headerf", "footerl", "footerr", "footerf", "bkmkstart", "bkmkend", "fldinst",
  "mmathPr", "nonshppict", "blipuid", "panose", "xmlopen", "wgrffmtfilter", "passwordhash", "listtext", "defchp", "defpap",
])

export function extractRtf(src: string): string {
  const out: string[] = []
  const stack: { skip: boolean; uc: number }[] = []
  let skip = false
  let uc = 1
  let pendingSkip = 0
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]!
    if (ch === "{") {
      stack.push({ skip, uc })
      i++
      continue
    }
    if (ch === "}") {
      const s = stack.pop()
      if (s) {
        skip = s.skip
        uc = s.uc
      }
      i++
      continue
    }
    if (ch === "\\") {
      const next = src[i + 1]
      if (next === undefined) break
      if (next === "\\" || next === "{" || next === "}") {
        if (!skip) out.push(next)
        i += 2
        continue
      }
      if (next === "'") {
        const hex = src.slice(i + 2, i + 4)
        if (pendingSkip > 0) pendingSkip--
        else if (!skip) out.push(cp1252(new Uint8Array([parseInt(hex, 16) || 0x3f])))
        i += 4
        continue
      }
      if (next === "*") {
        skip = true
        i += 2
        continue
      }
      if (next === "~") {
        if (!skip) out.push(" ")
        i += 2
        continue
      }
      if (next === "-" || next === "_") {
        if (!skip && next === "_") out.push("-")
        i += 2
        continue
      }
      if (next === "\n" || next === "\r") {
        if (!skip) out.push("\n")
        i += 2
        continue
      }
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i + 1, i + 40))
      if (!m) {
        i += 2
        continue
      }
      const word = m[1]!
      const arg = m[2] !== undefined ? Number(m[2]) : undefined
      i += 1 + m[0].length
      if (RTF_SKIP_DESTINATIONS.has(word)) {
        skip = true
        continue
      }
      if (skip) continue
      switch (word) {
        case "par":
        case "line":
        case "sect":
        case "row":
          out.push("\n")
          break
        case "page":
          out.push("\n")
          break
        case "tab":
        case "cell":
          out.push("\t")
          break
        case "emdash":
          out.push("—")
          break
        case "endash":
          out.push("–")
          break
        case "bullet":
          out.push("•")
          break
        case "lquote":
          out.push("‘")
          break
        case "rquote":
          out.push("’")
          break
        case "ldblquote":
          out.push("“")
          break
        case "rdblquote":
          out.push("”")
          break
        case "uc":
          uc = arg ?? 1
          break
        case "u": {
          let code = arg ?? 0
          if (code < 0) code += 65536
          out.push(String.fromCharCode(code))
          pendingSkip = uc
          break
        }
      }
      continue
    }
    if (ch === "\r" || ch === "\n") {
      i++
      continue
    }
    if (pendingSkip > 0) {
      pendingSkip--
      i++
      continue
    }
    if (!skip) out.push(ch)
    i++
  }
  return tidy(out.join(""))
}
