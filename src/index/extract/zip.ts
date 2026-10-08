import { inflateRawSync } from "node:zlib"

/** Minimal read-only ZIP reader for Office Open XML, OpenDocument and EPUB files. */

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  localOffset: number
}

const MAX_ENTRY_BYTES = 256 * 1024 * 1024

export class ZipReader {
  readonly entries = new Map<string, ZipEntry>()
  private view: DataView

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    this.readCentralDirectory()
  }

  static isZip(buf: Uint8Array): boolean {
    return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5) && (buf[3] === 4 || buf[3] === 6)
  }

  private readCentralDirectory() {
    const { buf, view } = this
    const min = Math.max(0, buf.length - 22 - 0xffff)
    let eocd = -1
    for (let i = buf.length - 22; i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error("not a zip archive (no end of central directory)")
    const count = view.getUint16(eocd + 10, true)
    let off = view.getUint32(eocd + 16, true)
    if (off === 0xffffffff) throw new Error("zip64 archives are not supported")
    const dec = new TextDecoder()
    for (let n = 0; n < count && off + 46 <= buf.length; n++) {
      if (view.getUint32(off, true) !== 0x02014b50) break
      const flags = view.getUint16(off + 8, true)
      const method = view.getUint16(off + 10, true)
      const compressedSize = view.getUint32(off + 20, true)
      const size = view.getUint32(off + 24, true)
      const nameLen = view.getUint16(off + 28, true)
      const extraLen = view.getUint16(off + 30, true)
      const commentLen = view.getUint16(off + 32, true)
      const localOffset = view.getUint32(off + 42, true)
      const nameBytes = buf.subarray(off + 46, off + 46 + nameLen)
      const name = flags & 0x800 ? dec.decode(nameBytes) : latin1(nameBytes)
      this.entries.set(name, { name, method, compressedSize, size, localOffset })
      off += 46 + nameLen + extraLen + commentLen
    }
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  names(): string[] {
    return [...this.entries.keys()]
  }

  read(name: string): Uint8Array | null {
    const e = this.entries.get(name)
    if (!e) return null
    if (e.size > MAX_ENTRY_BYTES) throw new Error(`zip entry too large: ${name}`)
    const { view, buf } = this
    const lo = e.localOffset
    if (lo + 30 > buf.length || view.getUint32(lo, true) !== 0x04034b50) throw new Error(`corrupt zip entry: ${name}`)
    const start = lo + 30 + view.getUint16(lo + 26, true) + view.getUint16(lo + 28, true)
    const data = buf.subarray(start, start + e.compressedSize)
    if (e.method === 0) return data
    if (e.method === 8) return new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }))
    throw new Error(`unsupported zip compression method ${e.method}`)
  }

  text(name: string): string | null {
    const data = this.read(name)
    return data ? new TextDecoder().decode(data) : null
  }
}

function latin1(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return s
}
