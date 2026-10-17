/** Small synthetic MOBI 6 books: no external converter or copyrighted book fixture needed. */
export function mobi(records: Uint8Array[], options: { compression?: number; encoding?: number; flags?: number; textLength?: number; version?: number; encryption?: number; recordSize?: number } = {}): Uint8Array {
  const header = new Uint8Array(248)
  const h = new DataView(header.buffer)
  h.setUint16(0, options.compression ?? 1)
  h.setUint32(4, options.textLength ?? records.reduce((sum, r) => sum + r.length, 0))
  h.setUint16(8, records.length)
  h.setUint16(10, options.recordSize ?? 4096)
  h.setUint16(12, options.encryption ?? 0)
  header.set(new TextEncoder().encode("MOBI"), 16)
  h.setUint32(20, 232)
  h.setUint32(24, 2)
  h.setUint32(28, options.encoding ?? 65001)
  h.setUint32(36, options.version ?? 6)
  h.setUint16(242, options.flags ?? 0)
  const parts = [header, ...records]
  let offset = 78 + parts.length * 8 + 2
  const out = new Uint8Array(offset + parts.reduce((sum, r) => sum + r.length, 0))
  const v = new DataView(out.buffer)
  out.set(new TextEncoder().encode("BOOKMOBI"), 60)
  v.setUint16(76, parts.length)
  for (let i = 0; i < parts.length; i++) {
    v.setUint32(78 + i * 8, offset)
    out.set(parts[i]!, offset)
    offset += parts[i]!.length
  }
  return out
}
