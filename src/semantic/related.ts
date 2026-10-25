import { VectorIndex } from "./search.ts"

export interface RelatedMatch { file: number; score: number; row: number }

/**
 * At most eight distinct, evenly spaced source passages vote. Each candidate takes its best
 * vote plus a quarter of its second best, never a sum over its length. Log penalties discount
 * long candidates and text repeated across the permitted collection (including the source).
 * Scores are affinities, not probabilities. A 0.75 cosine floor filters weak neighbours.
 */
export async function relatedByFile(index: VectorIndex, source: number, rows: Uint8Array, cancelled: () => boolean = () => false): Promise<RelatedMatch[] | null> {
  const distinct = new Map<number, number>()
  for (let row = 0; row < index.size; row++) {
    if (rows[row] && index.file[row] === source && index.start[row]! >= 0) distinct.set(index.vector[row]!, row)
  }
  const sourceRows = [...distinct.values()]
  const count = Math.min(8, sourceRows.length)
  const sample = Array.from({ length: count }, (_, i) => sourceRows[Math.floor(i * (sourceRows.length - 1) / Math.max(count - 1, 1))]!)
  const best = new Map<number, { first: number; second: number; row: number }>()
  for (const sourceRow of sample) {
    // Yield between scans so superseding requests and AbortSignals can actually be observed.
    await new Promise((r) => setTimeout(r, 0))
    if (cancelled()) return null
    const scores = index.score(index.passageVector(sourceRow))
    const vote = new Map<number, { score: number; row: number }>()
    for (let row = 0; row < index.size; row++) {
      if (row % 8192 === 0) {
        await new Promise((r) => setTimeout(r, 0))
        if (cancelled()) return null
      }
      const file = index.file[row]!
      if (!rows[row] || file <= 0 || file === source || index.start[row]! < 0 || scores[row]! < 0.75) continue
      const score = scores[row]! - 0.025 * Math.log(Math.max(index.passages(file), 1))
        - 0.06 * Math.log(Math.max(index.sharing(row, rows), index.sharing(sourceRow, rows), 1))
      const prior = vote.get(file)
      if (score > 0 && (!prior || score > prior.score)) vote.set(file, { score, row })
    }
    for (const [file, v] of vote) {
      const b = best.get(file)
      if (!b) best.set(file, { first: v.score, second: 0, row: v.row })
      else if (v.score > b.first) { b.second = b.first; b.first = v.score; b.row = v.row }
      else b.second = Math.max(b.second, v.score)
    }
  }
  return [...best].map(([file, b]) => ({ file, score: b.first + 0.25 * b.second, row: b.row }))
    .sort((a, b) => b.score - a.score || a.file - b.file)
}
