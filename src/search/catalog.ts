import type { Database } from "bun:sqlite"
import { home } from "../config.ts"
import type { Kind } from "../kinds.ts"
import { editDistance } from "../util/text.ts"
import { charMask, matchPath, parseFuzzyTerms, type FuzzyTerm } from "./fuzzy.ts"
import type { Filters } from "./query.ts"

/** Columns read for each entry, in this order. */
const COLUMNS = "id, path, kind, ext, is_dir, size, mtime, seq"
type Row = [id: number, path: string, kind: Kind, ext: string, isDir: number, size: number, mtime: number, seq: number]

/**
 * In-memory list of every indexed path, for instant name matching (like fzf/fff).
 *
 * Entries live in parallel arrays, numbers in typed arrays: an entire disk is a million entries
 * or more. The typed arrays keep spare room at their end, so only the first `size` items count.
 */
export class Catalog {
  /** Entries in the catalog. */
  size = 0
  ids = new Int32Array(0)
  paths: string[] = []
  /** Path shown to the user and matched against: relative to home, or absolute outside it. */
  display: string[] = []
  /** `display` in lower case (the same string when it has no capitals). */
  lower: string[] = []
  nameStart = new Int32Array(0)
  kinds: Kind[] = []
  exts: string[] = []
  isDir = new Uint8Array(0)
  sizes = new Float64Array(0)
  mtimes = new Float64Array(0)
  masks = new Int32Array(0)
  /** Position + 1 of each file id in the arrays above (0: not in the catalog). */
  private pos = new Int32Array(0)
  /** One copy of each kind and extension string. */
  private interned = new Map<string, string>()
  private h = home()
  maxId = 0
  /** Highest `files.seq` seen: rows changed in place since then are reloaded. */
  maxSeq = 0
  /** Last row of the `removed` log applied: files removed since then are dropped. */
  removedSeen = 0
  private cache: { key: string; matches: Int32Array } | null = null

  indexOf(id: number): number | undefined {
    const p = id < this.pos.length ? this.pos[id]! : 0
    return p > 0 ? p - 1 : undefined
  }

  displayFor(path: string): string {
    if (path === this.h) return "~"
    return path.startsWith(this.h + "/") ? path.slice(this.h.length + 1) : path
  }

  /**
   * Load everything (fresh), or only what changed since the last load (incremental): rows added
   * since, rows the indexer updated in place (new size, mtime...) and rows it removed. All of it
   * is read in one transaction, so from one snapshot of the index.
   */
  load(db: Database, incremental = false) {
    db.transaction(() => {
      if (incremental && !this.missedRemovals(db)) this.loadChanges(db)
      else this.reset(db)
      this.append(db.query(`SELECT ${COLUMNS} FROM files WHERE id > ? ORDER BY id`).values(this.maxId) as Row[])
    })()
    this.cache = null
  }

  /** Empty the catalog, and start following the removed log from its end. */
  private reset(db: Database) {
    this.size = 0
    this.ids = new Int32Array(0)
    this.paths = []
    this.display = []
    this.lower = []
    this.nameStart = new Int32Array(0)
    this.kinds = []
    this.exts = []
    this.isDir = new Uint8Array(0)
    this.sizes = new Float64Array(0)
    this.mtimes = new Float64Array(0)
    this.masks = new Int32Array(0)
    this.pos = new Int32Array(0)
    this.maxId = 0
    this.maxSeq = (db.query("SELECT COALESCE(MAX(seq), 0) AS s FROM files").get() as { s: number }).s
    this.removedSeen = (db.query("SELECT COALESCE(MAX(n), 0) AS n FROM removed").get() as { n: number }).n
  }

  /** The removed log was trimmed past the last row this catalog applied: only a fresh load is right. */
  private missedRemovals(db: Database): boolean {
    const first = (db.query("SELECT MIN(n) AS n FROM removed").get() as { n: number | null }).n
    return first !== null && first > this.removedSeen + 1
  }

  private loadChanges(db: Database) {
    const changed = db.query(`SELECT ${COLUMNS} FROM files WHERE seq > ? AND id <= ?`).values(this.maxSeq, this.maxId) as Row[]
    for (const r of changed) {
      const i = this.indexOf(r[0])
      if (i !== undefined) {
        this.kinds[i] = this.intern(r[2]) as Kind
        this.exts[i] = this.intern(r[3])
        this.isDir[i] = r[4]
        this.sizes[i] = r[5]
        this.mtimes[i] = r[6]
      }
      if (r[7] > this.maxSeq) this.maxSeq = r[7]
    }
    const removed = db.query("SELECT n, id FROM removed WHERE n > ? ORDER BY n").values(this.removedSeen) as [number, number][]
    if (!removed.length) return
    for (const [n, id] of removed) {
      const i = this.indexOf(id)
      if (i !== undefined) this.removeAt(i)
      this.removedSeen = n
    }
    // SQLite gives a new row the id of a removed one when that was the highest: such rows come
    // back with an id this catalog has seen already.
    this.append(
      db.query(`SELECT ${COLUMNS} FROM files WHERE id <= ? AND id IN (SELECT id FROM removed WHERE n > ?) ORDER BY id`).values(this.maxId, removed[0]![0] - 1) as Row[],
    )
  }

  private intern(s: string): string {
    const known = this.interned.get(s)
    if (known !== undefined) return known
    this.interned.set(s, s)
    return s
  }

  /** Make room for `n` entries in all, and for ids up to `maxId`. */
  private reserve(n: number, maxId: number) {
    if (n > this.ids.length) {
      const cap = Math.max(n, Math.ceil(this.ids.length * 1.5), 1024)
      const grow = <T extends Int32Array | Uint8Array | Float64Array>(a: T, make: (len: number) => T): T => {
        const b = make(cap)
        b.set(a.subarray(0, this.size) as never)
        return b
      }
      this.ids = grow(this.ids, (l) => new Int32Array(l))
      this.nameStart = grow(this.nameStart, (l) => new Int32Array(l))
      this.isDir = grow(this.isDir, (l) => new Uint8Array(l))
      this.sizes = grow(this.sizes, (l) => new Float64Array(l))
      this.mtimes = grow(this.mtimes, (l) => new Float64Array(l))
      this.masks = grow(this.masks, (l) => new Int32Array(l))
    }
    if (maxId >= this.pos.length) {
      const pos = new Int32Array(Math.max(maxId + 1, Math.ceil(this.pos.length * 1.5), 1024))
      pos.set(this.pos)
      this.pos = pos
    }
  }

  private append(rows: Row[]) {
    if (!rows.length) return
    // Rows come in id order, so the last has the highest id.
    this.reserve(this.size + rows.length, Math.max(this.maxId, rows[rows.length - 1]![0]))
    for (const r of rows) {
      const id = r[0]
      const idx = this.size++
      const path = r[1]
      const disp = this.displayFor(path)
      this.ids[idx] = id
      this.paths[idx] = path
      this.display[idx] = disp
      // One pass gives the character mask, the start of the file name and whether there are
      // capitals: toLowerCase is the costliest step, and most paths have none.
      let mask = 0
      let slash = -1
      let lowerSame = true
      for (let k = 0; k < disp.length; k++) {
        let c = disp.charCodeAt(k)
        if (c >= 65 && c <= 90) {
          lowerSame = false
          c += 32
        }
        if (c >= 97 && c <= 122) mask |= 1 << (c - 97)
        else if (c >= 48 && c <= 57) mask |= 1 << 26
        else if (c === 46) mask |= 1 << 27 // .
        else if (c === 95 || c === 45) mask |= 1 << 28 // _ -
        else if (c === 47) {
          mask |= 1 << 29 // /
          slash = k
        } else if (c > 127) {
          mask |= 1 << 30
          lowerSame = false
        }
      }
      const lower = lowerSame ? disp : disp.toLowerCase()
      this.lower[idx] = lower
      // Lower-casing other scripts can change more than the letter: count what it gives.
      this.masks[idx] = mask & (1 << 30) ? charMask(lower) : mask
      this.nameStart[idx] = slash + 1
      this.kinds[idx] = this.intern(r[2]) as Kind
      this.exts[idx] = this.intern(r[3])
      this.isDir[idx] = r[4]
      this.sizes[idx] = r[5]
      this.mtimes[idx] = r[6]
      this.pos[id] = idx + 1
      if (id > this.maxId) this.maxId = id
    }
  }

  /** Drop entry `i`: the last entry takes its place. */
  private removeAt(i: number) {
    const last = this.size - 1
    this.pos[this.ids[i]!] = 0
    if (i !== last) {
      this.ids[i] = this.ids[last]!
      this.paths[i] = this.paths[last]!
      this.display[i] = this.display[last]!
      this.lower[i] = this.lower[last]!
      this.nameStart[i] = this.nameStart[last]!
      this.kinds[i] = this.kinds[last]!
      this.exts[i] = this.exts[last]!
      this.isDir[i] = this.isDir[last]!
      this.sizes[i] = this.sizes[last]!
      this.mtimes[i] = this.mtimes[last]!
      this.masks[i] = this.masks[last]!
      this.pos[this.ids[i]!] = i + 1
    }
    this.paths.length = last
    this.display.length = last
    this.lower.length = last
    this.kinds.length = last
    this.exts.length = last
    this.size = last
  }

  /**
   * Up to `limit` entries that pass `keep`, newest first. One pass with a small sorted list of
   * the best so far: sorting a million entries for a screenful takes half a second.
   */
  newest(limit: number, keep: (i: number) => boolean): number[] {
    const best: number[] = []
    if (limit <= 0) return best
    const mt = this.mtimes
    for (let i = 0; i < this.size; i++) {
      const t = mt[i]!
      if (best.length === limit && t <= mt[best[limit - 1]!]!) continue
      if (!keep(i)) continue
      // Insert in place: after the entries at least as new, so ties keep catalog order.
      let lo = 0
      let hi = best.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (mt[best[mid]!]! >= t) lo = mid + 1
        else hi = mid
      }
      best.splice(lo, 0, i)
      if (best.length > limit) best.pop()
    }
    return best
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
    else for (let i = 0; i < this.size; i++) consider(i)
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
    for (let i = 0; i < this.size; i++) {
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
    return this.newest(limit, (i) => this.passes(i, filters))
  }

  /** Regex over display paths. */
  regex(re: RegExp, filters: Filters, limit: number): { idx: number; positions: number[] }[] {
    const out: { idx: number; positions: number[] }[] = []
    for (let i = 0; i < this.size && out.length < limit; i++) {
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
