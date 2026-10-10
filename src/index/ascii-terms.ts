/**
 * The index terms of plain ASCII text, straight from its bytes: most files are, and decoding
 * them, lower-casing them and making a string of every word costs more than the rest of their
 * extraction. The result is what `indexTerms` gives for the decoded text (see there).
 */

/** Per byte: 0 between words, BAD for bytes that are not plain text, else the lower-cased byte. */
const BAD = 1
const CLASS = new Uint8Array(256)
for (let b = 0; b < 256; b++) {
  if (b === 0 || b >= 0x80) CLASS[b] = BAD
  else if ((b >= 97 && b <= 122) || (b >= 48 && b <= 57)) CLASS[b] = b
  else if (b >= 65 && b <= 90) CLASS[b] = b | 0x20
}

/**
 * Distinct words of a text, by where they first occur in it: a table started over for each
 * text. Each slot is four numbers side by side (generation, hash, start, length), so that a
 * lookup reads one cache line.
 */
let seen = new Int32Array(4096 * 4)
let gen = 0

/** Words already reported this run, kept in `arena`: slots of (used, hash, start, length). */
let done = new Int32Array((1 << 16) * 4)
let doneCount = 0
let arena = new Uint8Array(1 << 20)
let arenaLen = 0
let doneRun = ""
/** As for the other texts' terms (see extract-job.ts): reporting a few twice does no harm. */
const MAX_DONE = 250_000

const latin1 = new TextDecoder("latin1")

export interface AsciiTerms {
  /** The distinct words, lower-cased, separated by spaces: the FTS body, in UTF-8. */
  body: Uint8Array
  /** Words of at most 64 characters not reported before during `run`. */
  fresh: string[]
}

/** Null when the text is not plain ASCII (or holds NUL bytes, which extraction drops). */
export function asciiTerms(buf: Uint8Array, run: string): AsciiTerms | null {
  if (run !== doneRun) {
    clearDone()
    doneRun = run
  }
  if (++gen === 0x7fffffff) {
    seen.fill(0)
    gen = 1
  }
  const out = new Uint8Array(buf.length)
  let outLen = 0
  let words = 0
  const fresh: string[] = []
  const n = buf.length
  let i = 0
  while (i < n) {
    let c = CLASS[buf[i]!]!
    if (c <= BAD) {
      if (c === BAD) return null
      i++
      continue
    }
    // Written out as it goes, and taken back if it was seen already.
    const at = outLen === 0 ? 0 : outLen + 1
    let o = at
    const start = i
    // FNV-1a of the lower-cased word.
    let h = 0x811c9dc5 | 0
    do {
      h = Math.imul(h ^ c, 0x01000193)
      out[o++] = c
      c = ++i < n ? CLASS[buf[i]!]! : 0
    } while (c > BAD)
    const len = i - start
    let mask = (seen.length >> 2) - 1
    let j = h & mask
    let dup = false
    while (seen[j << 2] === gen) {
      const s = j << 2
      if (seen[s + 1] === h && seen[s + 3] === len && same(out, seen[s + 2]!, out, at, len)) {
        dup = true
        break
      }
      j = (j + 1) & mask
    }
    if (dup) continue
    const s = j << 2
    seen[s] = gen
    seen[s + 1] = h
    seen[s + 2] = at
    seen[s + 3] = len
    if (++words * 2 > mask + 1) growSeen()
    if (at) out[at - 1] = 0x20
    outLen = o
    if (len <= 64 && report(out, at, len, h)) fresh.push(latin1.decode(out.subarray(at, o)))
  }
  return { body: out.slice(0, outLen), fresh }
}

function same(a: Uint8Array, i: number, b: Uint8Array, j: number, len: number): boolean {
  for (let k = 0; k < len; k++) if (a[i + k] !== b[j + k]) return false
  return true
}

/** Record a lower-cased word as reported; false if it was already. */
function report(word: Uint8Array, at: number, len: number, h: number): boolean {
  let mask = (done.length >> 2) - 1
  let j = h & mask
  while (done[j << 2]) {
    const s = j << 2
    if (done[s + 1] === h && done[s + 3] === len && same(arena, done[s + 2]!, word, at, len)) return false
    j = (j + 1) & mask
  }
  if (doneCount >= MAX_DONE) {
    clearDone()
    mask = (done.length >> 2) - 1
    j = h & mask
  }
  if (arenaLen + len > arena.length) {
    const bigger = new Uint8Array(Math.max(arena.length * 2, arenaLen + len))
    bigger.set(arena.subarray(0, arenaLen))
    arena = bigger
  }
  arena.set(word.subarray(at, at + len), arenaLen)
  const s = j << 2
  done[s] = 1
  done[s + 1] = h
  done[s + 2] = arenaLen
  done[s + 3] = len
  arenaLen += len
  if (++doneCount * 2 > mask + 1) growDone()
  return true
}

function clearDone() {
  done.fill(0)
  doneCount = 0
  arenaLen = 0
}

/** Double a table of (marker, hash, start, length) slots, keeping the slots marked `mark`. */
function grow(table: Int32Array<ArrayBuffer>, mark: number): Int32Array<ArrayBuffer> {
  const size = table.length >> 2
  const bigger = new Int32Array(table.length * 2)
  const mask = size * 2 - 1
  for (let i = 0; i < table.length; i += 4) {
    if (table[i] !== mark) continue
    let j = table[i + 1]! & mask
    while (bigger[j << 2] === mark) j = (j + 1) & mask
    bigger.set(table.subarray(i, i + 4), j << 2)
  }
  return bigger
}

function growSeen() {
  seen = grow(seen, gen)
}

function growDone() {
  done = grow(done, 1)
}
