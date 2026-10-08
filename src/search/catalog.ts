import type { Database } from "bun:sqlite"
import { home } from "../config.ts"
import type { Kind } from "../kinds.ts"
import { editDistance } from "../util/text.ts"
import { charMask, matchPath, parseFuzzyTerms, type FuzzyTerm } from "./fuzzy.ts"
import type { Filters } from "./query.ts"

/** In-memory list of every indexed path, for instant name matching (like fzf/fff). */
export class Catalog {
  ids: number[] = []
  paths: string[] = []
  /** Path shown to the user and matched against: relative to home, or absolute outside it. */
  display: string[] = []
  lower: string[] = []
  nameStart: number[] = []
  kinds: Kind[] = []
  exts: string[] = []
  isDir: Uint8Array = new Uint8Array(0)
  sizes: number[] = []
  mtimes: number[] = []
  contentState: Uint8Array = new Uint8Array(0)
  masks: Int32Array = new Int32Array(0)
  private byId = new Map<number, number>()
  private h = home()
  maxId = 0
  private cache: { key: string; matches: Int32Array } | null = null

  get size() {
    return this.ids.length
  }

  indexOf(id: number): number | undefined {
    return this.byId.get(id)
  }

  displayFor(path: string): string {
    if (path === this.h) return "~"
    return path.startsWith(this.h + "/") ? path.slice(this.h.length + 1) : path
  }

  /** Load everything (fresh), or only rows newer than what we have (incremental). */
  load(db: Database, incremental = false) {
    if (!incremental) {
      this.ids = []
      this.paths = []
      this.display = []
      this.lower = []
      this.nameStart = []
      this.kinds = []
      this.exts = []
      this.sizes = []
      this.mtimes = []
      this.byId.clear()
      this.maxId = 0
    }
    const rows = db
      .query("SELECT id, path, kind, ext, is_dir, size, mtime, content_state FROM files WHERE id > ? ORDER BY id")
      .all(this.maxId) as { id: number; path: string; kind: Kind; ext: string; is_dir: number; size: number; mtime: number; content_state: number }[]
    const base = this.ids.length
    const n = base + rows.length
    const isDir = new Uint8Array(n)
    isDir.set(this.isDir.subarray(0, base))
    const cs = new Uint8Array(n)
    cs.set(this.contentState.subarray(0, base))
    const masks = new Int32Array(n)
    masks.set(this.masks.subarray(0, base))
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!
      const idx = base + i
      const disp = this.displayFor(r.path)
      const lower = disp.toLowerCase()
      this.ids.push(r.id)
      this.paths.push(r.path)
      this.display.push(disp)
      this.lower.push(lower)
      this.nameStart.push(disp.lastIndexOf("/") + 1)
      this.kinds.push(r.kind)
      this.exts.push(r.ext)
      this.sizes.push(r.size)
      this.mtimes.push(r.mtime)
      isDir[idx] = r.is_dir
      cs[idx] = r.content_state
      masks[idx] = charMask(lower)
      this.byId.set(r.id, idx)
      if (r.id > this.maxId) this.maxId = r.id
    }
    this.isDir = isDir
    this.contentState = cs
    this.masks = masks
    this.cache = null
  }

  /** Whether entry `i` passes the filters. */
  passes(i: number, f: Filters): boolean {
    if (f.kinds && !f.kinds.has(this.kinds[i]!)) return false
    if (f.notKinds && f.notKinds.has(this.kinds[i]!)) return false
    if (f.exts && !f.exts.has(this.exts[i]!)) return false
    if (f.sizeMin !== undefined && this.sizes[i]! < f.sizeMin) return false
    if (f.sizeMax !== undefined && this.sizes[i]! > f.sizeMax) return false
    if (f.mtimeMin !== undefined && this.mtimes[i]! < f.mtimeMin) return false
    if (f.mtimeMax !== undefined && this.mtimes[i]! >= f.mtimeMax) return false
    if (f.inPaths.length) {
      const p = this.paths[i]!
      if (!f.inPaths.some((pre) => pre === "/" || p.startsWith(pre + "/"))) return false
    }
    if (f.pathContains.length) {
      const l = this.lower[i]!
      if (!f.pathContains.every((s) => l.includes(s))) return false
    }
    return true
  }

  /**
   * Fuzzy-match the query against display paths. Returns top `limit` entries.
   * `bias(i)` adds frecency/recency points.
   */
  fuzzy(query: string, filters: Filters, limit: number, bias?: (i: number) => number): { idx: number; score: number; positions: number[] }[] {
    const terms = parseFuzzyTerms(query)
    if (!terms.length) return []
    const positive = terms.filter((t) => !t.negate)
    let qmask = 0
    for (const t of positive) qmask |= charMask(t.text)
    // Narrow from the previous result set while the user keeps typing.
    const key = JSON.stringify([terms.map((t) => [t.text, t.kind, t.negate])])
    let candidates: Int32Array | null = null
    if (this.cache && positive.length === terms.length && terms.every((t) => t.kind === "fuzzy")) {
      const prevQ = JSON.parse(this.cache.key) as [[string, string, boolean][]]
      const prevTerms = prevQ[0]
      if (
        prevTerms.length === terms.length &&
        prevTerms.every((p, i) => p[1] === "fuzzy" && !p[2] && isSubsequence(p[0], terms[i]!.text))
      ) {
        candidates = this.cache.matches
      }
    }
    const matched: number[] = []
    const top = new TopK(limit)
    const masks = this.masks
    const consider = (i: number) => {
      if ((masks[i]! & qmask) !== qmask) return
      const m = matchPath(this.display[i]!, this.lower[i]!, this.nameStart[i]!, terms, false)
      if (!m) return
      matched.push(i)
      if (!this.passes(i, filters)) return
      // Tie-break: shorter paths first.
      top.push(i, m.score + (bias ? bias(i) : 0) - this.display[i]!.length / 1000)
    }
    if (candidates) for (const i of candidates) consider(i)
    else for (let i = 0; i < this.ids.length; i++) consider(i)
    this.cache = { key, matches: Int32Array.from(matched) }
    // Positions (for highlighting) only for the winners.
    return top.sorted().map(({ idx, score }) => ({ idx, score, positions: matchPath(this.display[idx]!, this.lower[idx]!, this.nameStart[idx]!, terms, true)?.positions ?? [] }))
  }

  /** Total entries that matched the last fuzzy query (before filters/limit). */
  get lastMatchCount(): number {
    return this.cache?.matches.length ?? 0
  }

  /**
   * Typo-tolerant fallback: file-name words within edit distance of each term
   * ("mian" finds main.rs, "recieve" finds receive.py).
   */
  typo(query: string, filters: Filters, limit: number): { idx: number; score: number; positions: number[] }[] {
    const terms: FuzzyTerm[] = parseFuzzyTerms(query).filter((t) => !t.negate && t.kind === "fuzzy" && t.text.length >= 4)
    if (!terms.length) return []
    const out: { idx: number; score: number; positions: number[] }[] = []
    for (let i = 0; i < this.ids.length; i++) {
      const lower = this.lower[i]!
      const start = this.nameStart[i]!
      let total = 0
      const positions: number[] = []
      let ok = true
      for (const t of terms) {
        const max = t.text.length >= 8 ? 2 : 1
        let best = max + 1
        let bestAt = -1
        let bestLen = 0
        const re = /[\p{L}\p{N}]+/gu
        re.lastIndex = start
        const name = lower
        let m: RegExpExecArray | null
        while ((m = re.exec(name))) {
          const w = m[0]
          if (Math.abs(w.length - t.text.length) > max) continue
          const d = editDistance(t.text, w, max)
          if (d < best) {
            best = d
            bestAt = m.index
            bestLen = w.length
          }
        }
        if (best > max) {
          ok = false
          break
        }
        total += t.text.length * 8 - best * 12
        for (let p = bestAt; p < bestAt + bestLen; p++) positions.push(p)
      }
      if (!ok || !this.passes(i, filters)) continue
      out.push({ idx: i, score: total, positions })
    }
    out.sort((a, b) => b.score - a.score || this.display[a.idx]!.length - this.display[b.idx]!.length)
    if (out.length > limit) out.length = limit
    return out
  }

  /** All entries that pass the filters, most recent first (empty query with filters). */
  browse(filters: Filters, limit: number): number[] {
    const out: number[] = []
    for (let i = 0; i < this.ids.length; i++) if (this.passes(i, filters)) out.push(i)
    out.sort((a, b) => this.mtimes[b]! - this.mtimes[a]!)
    return out.slice(0, limit)
  }

  /** Regex over display paths. */
  regex(re: RegExp, filters: Filters, limit: number): { idx: number; positions: number[] }[] {
    const out: { idx: number; positions: number[] }[] = []
    for (let i = 0; i < this.ids.length && out.length < limit; i++) {
      const d = this.display[i]!
      re.lastIndex = 0
      const m = re.exec(d)
      if (!m || !this.passes(i, filters)) continue
      const positions: number[] = []
      for (let p = m.index; p < m.index + Math.max(1, m[0].length); p++) positions.push(p)
      out.push({ idx: i, positions })
    }
    return out
  }
}

/** Keeps the `k` best (highest score) items seen so far. */
class TopK {
  private idx: number[] = []
  private score: number[] = []
  private min = -Infinity
  constructor(private k: number) {}

  push(idx: number, score: number) {
    if (this.idx.length >= this.k * 2) {
      if (score <= this.min) return
    }
    this.idx.push(idx)
    this.score.push(score)
    if (this.idx.length >= this.k * 4) this.compact()
  }

  private compact() {
    const order = this.idx.map((_, i) => i).sort((a, b) => this.score[b]! - this.score[a]!)
    const keep = order.slice(0, this.k * 2)
    this.idx = keep.map((i) => this.idx[i]!)
    this.score = keep.map((i) => this.score[i]!)
    this.min = this.score[this.score.length - 1] ?? -Infinity
  }

  sorted(): { idx: number; score: number }[] {
    const order = this.idx.map((_, i) => i).sort((a, b) => this.score[b]! - this.score[a]!)
    return order.slice(0, this.k).map((i) => ({ idx: this.idx[i]!, score: this.score[i]! }))
  }
}

function isSubsequence(a: string, b: string): boolean {
  // Previous results are a superset when the new term contains the old as a subsequence.
  let j = 0
  for (let i = 0; i < b.length && j < a.length; i++) if (b[i] === a[j]) j++
  return j === a.length
}
