import type { Database } from "bun:sqlite"
import { readVocabChunks } from "../index/db.ts"
import { editDistance, foldTerm, ftsPrefix, ftsTerm, isLongWord } from "../util/text.ts"
import type { Req } from "./regex-plan.ts"

/**
 * The index vocabulary kept in memory as one newline-joined string, so substring and
 * suffix lookups are a handful of native indexOf calls even with millions of terms.
 */
export class Vocab {
  private joined = "\n"
  private offsets: number[] = []
  private count = 0
  maxId = 0
  private byLen = new Map<number, string[]>()
  /** Long words (see `isLongWord`), in vocabulary order, and their positions sorted by word. */
  private longs: string[] = []
  private longOrder: number[] | null = null
  /** Characters other than ASCII ones looked up so far, and whether any term has them. */
  private chars = new Map<string, boolean>()

  get size() {
    return this.count
  }

  load(db: Database, incremental = true) {
    if (!incremental) {
      this.joined = "\n"
      this.offsets = []
      this.count = 0
      this.maxId = 0
      this.byLen.clear()
      this.longs = []
      this.longOrder = null
      this.chars.clear()
    }
    const chunks = readVocabChunks(db, this.maxId)
    if (!chunks.length) return
    const parts: string[] = []
    let off = this.joined.length
    for (const c of chunks) {
      for (const term of c.terms) {
        this.offsets.push(off)
        parts.push(term)
        off += term.length + 1
        // Hashes and the like are never what a typo meant.
        if (isLongWord(term)) { this.longs.push(term); this.longOrder = null; continue }
        let bucket = this.byLen.get(term.length)
        if (!bucket) this.byLen.set(term.length, (bucket = []))
        bucket.push(term)
      }
      this.maxId = c.id
    }
    this.joined += parts.join("\n") + "\n"
    this.count += parts.length
    for (const [c, has] of this.chars) if (!has) this.chars.delete(c)
  }

  private termAt(offset: number): string {
    // Binary search the term that contains `offset`.
    let lo = 0
    let hi = this.offsets.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.offsets[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    const start = this.offsets[lo]!
    return this.joined.slice(start, this.joined.indexOf("\n", start))
  }

  /** Terms containing `needle` (which never spans two terms). */
  private scan(needle: string, limit: number): string[] | null {
    // Case-insensitive searches look up every case form of some letters (σ and ς, μ and µ), and
    // most forms are in no term: one pass for each such character saves one for each lookup.
    for (const c of needle) {
      if (c.charCodeAt(0) < 0x80) continue
      let has = this.chars.get(c)
      if (has === undefined) this.chars.set(c, (has = this.joined.includes(c)))
      if (!has) return []
    }
    const out = new Set<string>()
    let i = this.joined.indexOf(needle)
    while (i >= 0) {
      out.add(this.termAt(i))
      if (out.size > limit) return null
      const end = this.joined.indexOf("\n", i)
      i = end < 0 ? -1 : this.joined.indexOf(needle, end + 1)
    }
    return [...out]
  }

  /** Terms containing `sub`. null when there are more than `limit`. */
  containing(sub: string, limit = 400): string[] | null {
    if (!sub || sub.includes("\n")) return []
    return this.scan(sub, limit)
  }

  /** Terms ending with `suffix`. */
  endingWith(suffix: string, limit = 400): string[] | null {
    if (!suffix || suffix.includes("\n")) return []
    return this.scan(suffix + "\n", limit)
  }

  /** Long words (see `isLongWord`) starting with `prefix`. null when there are more than `limit`. */
  longStartingWith(prefix: string, limit = 64): string[] | null {
    if (!prefix || prefix.includes("\n")) return []
    if (!this.longOrder) {
      const longs = this.longs
      this.longOrder = longs.map((_, k) => k).sort((a, b) => (longs[a]! < longs[b]! ? -1 : longs[a]! > longs[b]! ? 1 : a - b))
    }
    const order = this.longOrder
    let lo = 0
    let hi = order.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.longs[order[mid]!]! < prefix) lo = mid + 1
      else hi = mid
    }
    const found: number[] = []
    for (let k = lo; k < order.length && this.longs[order[k]!]!.startsWith(prefix); k++) {
      if (found.length >= limit) return null
      found.push(order[k]!)
    }
    // In the order they were indexed in, as a scan of the vocabulary finds them.
    return found.sort((a, b) => a - b).map((k) => this.longs[k]!)
  }

  /** Terms within edit distance (1 for 4-7 letters, 2 for 8+). */
  similar(term: string, limit = 24): string[] {
    const max = term.length >= 8 ? 2 : term.length >= 4 ? 1 : 0
    if (max === 0) return []
    const out: { t: string; d: number }[] = []
    for (let len = term.length - max; len <= term.length + max; len++) {
      const bucket = this.byLen.get(len)
      if (!bucket) continue
      for (const t of bucket) {
        // Cheap reject: typos rarely change both the first and the last letter.
        if (t.charCodeAt(0) !== term.charCodeAt(0) && t.charCodeAt(t.length - 1) !== term.charCodeAt(term.length - 1)) continue
        const d = editDistance(term, t, max)
        if (d <= max && d > 0) out.push({ t, d })
      }
    }
    // Ties go by term, not by the order terms were indexed in, which differs from one rebuild to the next.
    out.sort((a, b) => a.d - b.d || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    return out.slice(0, limit).map((x) => x.t)
  }
}

const WORD_RUN = /[\p{L}\p{N}\p{Co}]+/gu

/**
 * FTS5 expression for documents that may contain the literal `lit` (case-insensitively).
 * Each word-run of the literal becomes a token condition: whole token, token prefix,
 * token suffix or token substring, depending on whether it touches the literal's edges.
 * Returns null when the literal gives no usable constraint.
 */
export function literalToFts(lit: string, vocab: Vocab | null): string | null {
  const folded = foldTerm(lit)
  const parts: string[] = []
  WORD_RUN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WORD_RUN.exec(folded))) {
    const run = m[0]
    const startBounded = m.index > 0
    const endBounded = m.index + run.length < folded.length
    if (startBounded && endBounded) {
      parts.push(ftsTerm(run))
    } else if (startBounded) {
      if (run.length >= 2) parts.push(ftsPrefix(run, (p) => vocab?.longStartingWith(p) ?? null))
    } else if (!vocab || run.length < 3) {
      // The run may sit inside a longer token: without the vocabulary there is no safe constraint.
      continue
    } else {
      const terms = endBounded ? vocab.endingWith(run) : vocab.containing(run)
      if (terms === null) continue // too common to help
      if (terms.length === 0) return "__no_match__"
      parts.push(terms.length === 1 ? ftsTerm(terms[0]!) : `(${terms.map(ftsTerm).join(" OR ")})`)
    }
  }
  if (!parts.length) return null
  return parts.length === 1 ? parts[0]! : parts.join(" AND ")
}

/** Map a regex requirement tree to an FTS5 expression (null = no constraint). */
export function reqToFts(req: Req, vocab: Vocab | null): string | null {
  switch (req.t) {
    case "all":
      return null
    case "lit":
      return literalToFts(req.s, vocab)
    case "and": {
      const parts = req.items.map((r) => reqToFts(r, vocab)).filter((p): p is string => p !== null)
      if (parts.includes("__no_match__")) return "__no_match__"
      if (!parts.length) return null
      return parts.length === 1 ? parts[0]! : parts.map((p) => `(${p})`).join(" AND ")
    }
    case "or": {
      const parts: string[] = []
      for (const r of req.items) {
        const p = reqToFts(r, vocab)
        if (p === null) return null
        if (p !== "__no_match__") parts.push(p)
      }
      if (!parts.length) return "__no_match__"
      return parts.length === 1 ? parts[0]! : parts.map((p) => `(${p})`).join(" OR ")
    }
  }
}
