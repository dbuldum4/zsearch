/**
 * Dot products of a query with many vectors, on Apple's Accelerate framework (part of macOS):
 * its BLAS reads the vectors about ten times faster than a loop in JavaScript. Elsewhere, or if
 * it can't be loaded, `scoreAll` returns false and the caller loops itself.
 */
import { dlopen, FFIType } from "bun:ffi"

type Sgemv = (order: number, trans: number, m: number, n: number, alpha: number, a: Float32Array, lda: number, x: Float32Array, incx: number, beta: number, y: Float32Array, incy: number) => void

let sgemv: Sgemv | null | undefined

function accelerate(): Sgemv | null {
  if (sgemv !== undefined) return sgemv
  sgemv = null
  if (process.platform !== "darwin" || process.env.ZSEARCH_NO_ACCELERATE) return sgemv
  try {
    const { symbols } = dlopen("/System/Library/Frameworks/Accelerate.framework/Accelerate", {
      cblas_sgemv: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.f32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.f32, FFIType.ptr, FFIType.i32], returns: FFIType.void },
    })
    sgemv = symbols.cblas_sgemv as unknown as Sgemv
  } catch {
    sgemv = null
  }
  return sgemv
}

/**
 * `out[k]` = the dot product of `query` with vector `k` of `values` (`count` vectors of `dim`
 * floats each). Returns false, leaving `out` alone, when Accelerate is not available.
 */
export function scoreAll(values: Float32Array, count: number, dim: number, query: Float32Array, out: Float32Array): boolean {
  const f = accelerate()
  if (!f || count === 0) return !!f
  // Row-major (101), not transposed (111): out[k] = Σ values[k][d] · query[d].
  f(101, 111, count, dim, 1, values, dim, query, 1, 0, out, 1)
  return true
}
