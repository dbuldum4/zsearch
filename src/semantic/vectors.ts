/** Vector helpers. Stored vectors are int8 with a float32 scale: [scale:f32][dims x int8]. */

export function normalize(v: Float32Array): Float32Array {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!
  const n = Math.sqrt(s)
  if (n > 0) for (let i = 0; i < v.length; i++) v[i]! /= n
  return v
}

export function encodeVector(v: Float32Array): Uint8Array {
  let max = 0
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]!))
  const scale = max > 0 ? max / 127 : 1
  const out = new Uint8Array(4 + v.length)
  new DataView(out.buffer).setFloat32(0, scale, true)
  const q = new Int8Array(out.buffer, 4)
  for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i]! / scale)
  return out
}

export function decodeVector(blob: Uint8Array): { scale: number; q: Int8Array } {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  return { scale: dv.getFloat32(0, true), q: new Int8Array(blob.buffer, blob.byteOffset + 4, blob.byteLength - 4) }
}

/** A dense, append-only matrix of quantised vectors for brute-force search. */
export class VectorStore {
  dims = 0
  count = 0
  data = new Int8Array(0)
  scales = new Float32Array(0)
  fileIds = new Int32Array(0)
  starts = new Int32Array(0)
  ends = new Int32Array(0)

  reset(dims: number, capacity: number) {
    this.dims = dims
    this.count = 0
    this.data = new Int8Array(dims * Math.max(1, capacity))
    this.scales = new Float32Array(Math.max(1, capacity))
    this.fileIds = new Int32Array(Math.max(1, capacity))
    this.starts = new Int32Array(Math.max(1, capacity))
    this.ends = new Int32Array(Math.max(1, capacity))
  }

  private grow(min: number) {
    const cap = Math.max(min, this.scales.length * 2)
    const grow = <T extends Int8Array | Float32Array | Int32Array>(a: T, n: number): T => {
      const b = new (a.constructor as new (n: number) => T)(n)
      b.set(a)
      return b
    }
    this.data = grow(this.data, cap * this.dims)
    this.scales = grow(this.scales, cap)
    this.fileIds = grow(this.fileIds, cap)
    this.starts = grow(this.starts, cap)
    this.ends = grow(this.ends, cap)
  }

  add(fileId: number, start: number, end: number, blob: Uint8Array) {
    const { scale, q } = decodeVector(blob)
    if (this.dims === 0) this.reset(q.length, 1024)
    if (q.length !== this.dims) return
    if (this.count >= this.scales.length) this.grow(this.count + 1)
    this.data.set(q, this.count * this.dims)
    this.scales[this.count] = scale
    this.fileIds[this.count] = fileId
    this.starts[this.count] = start
    this.ends[this.count] = end
    this.count++
  }

  /** Top-k chunk indices by cosine similarity with `query` (normalised float vector). */
  search(query: Float32Array, k: number, allow?: (fileId: number) => boolean): { idx: number; score: number }[] {
    const { dims, count, data, scales } = this
    if (count === 0 || query.length !== dims) return []
    const top: { idx: number; score: number }[] = []
    let floor = -Infinity
    for (let r = 0; r < count; r++) {
      const off = r * dims
      let s = 0
      for (let d = 0; d < dims; d++) s += query[d]! * data[off + d]!
      s *= scales[r]!
      if (s <= floor && top.length >= k) continue
      if (allow && !allow(this.fileIds[r]!)) continue
      top.push({ idx: r, score: s })
      if (top.length > k * 2) {
        top.sort((a, b) => b.score - a.score)
        top.length = k
        floor = top[k - 1]!.score
      }
    }
    top.sort((a, b) => b.score - a.score)
    if (top.length > k) top.length = k
    return top
  }
}
