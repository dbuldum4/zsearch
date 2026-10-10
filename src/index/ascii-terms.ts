/**
 * The index terms of plain ASCII text, straight from its bytes: most files are, and decoding
 * them, lower-casing them and making a string of every word costs more than the rest of their
 * extraction. The result is what `indexTerms` gives for the decoded text (see there).
 */

/** Distinct words of a text, by where they first occur in it: a table started over for each text. */
let seenHash = new Int32Array(4096)
let seenStart = new Int32Array(4096)
let seenLen = new Int32Array(4096)
let seenGen = new Int32Array(4096)
let gen = 0

/** Words already reported this run, kept in `arena`. */
let doneHash = new Int32Array(1 << 16)
let doneStart = new Int32Array(1 << 16)
let doneLen = new Int32Array(1 << 16)
let doneUsed = new Uint8Array(1 << 16)
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
    seenGen.fill(0)
    gen = 1
  }
  const out = new Uint8Array(buf.length)
  let outLen = 0
  let words = 0
  const fresh: string[] = []
  const n = buf.length
  let i = 0
  while (i < n) {
    let b = buf[i]!
    if (b >= 0x80 || b === 0) return null
    if (!isWordByte(b)) {
      i++
      continue
    }
    const start = i
    // FNV-1a of the lower-cased word. Letters and digits all have 0x20 set once lower-cased.
    let h = 0x811c9dc5 | 0
    do {
      h = Math.imul(h ^ (b | 0x20), 0x01000193)
      b = ++i < n ? buf[i]! : 0x20
    } while (isWordByte(b))
    const len = i - start
    let mask = seenGen.length - 1
    let j = h & mask
    let seen = false
    while (seenGen[j] === gen) {
      if (seenHash[j] === h && seenLen[j] === len && sameLower(buf, seenStart[j]!, buf, start, len)) {
        seen = true
        break
      }
      j = (j + 1) & mask
    }
    if (seen) continue
    seenGen[j] = gen
    seenHash[j] = h
    seenStart[j] = start
    seenLen[j] = len
    if (++words * 2 > seenGen.length) growSeen()
    if (outLen) out[outLen++] = 0x20
    const at = outLen
    for (let k = start; k < i; k++) out[outLen++] = buf[k]! | 0x20
    if (len <= 64 && report(out, at, len, h)) fresh.push(latin1.decode(out.subarray(at, at + len)))
  }
  return { body: out.slice(0, outLen), fresh }
}

function isWordByte(b: number): boolean {
  return (b >= 97 && b <= 122) || (b >= 65 && b <= 90) || (b >= 48 && b <= 57)
}

function sameLower(a: Uint8Array, i: number, b: Uint8Array, j: number, len: number): boolean {
  for (let k = 0; k < len; k++) if ((a[i + k]! | 0x20) !== (b[j + k]! | 0x20)) return false
  return true
}

/** Record a lower-cased word as reported; false if it was already. */
function report(word: Uint8Array, at: number, len: number, h: number): boolean {
  let mask = doneUsed.length - 1
  let j = h & mask
  while (doneUsed[j]) {
    if (doneHash[j] === h && doneLen[j] === len && sameLower(arena, doneStart[j]!, word, at, len)) return false
    j = (j + 1) & mask
  }
  if (doneCount >= MAX_DONE) {
    clearDone()
    mask = doneUsed.length - 1
    j = h & mask
  }
  if (arenaLen + len > arena.length) {
    const bigger = new Uint8Array(Math.max(arena.length * 2, arenaLen + len))
    bigger.set(arena.subarray(0, arenaLen))
    arena = bigger
  }
  arena.set(word.subarray(at, at + len), arenaLen)
  doneUsed[j] = 1
  doneHash[j] = h
  doneStart[j] = arenaLen
  doneLen[j] = len
  arenaLen += len
  if (++doneCount * 2 > doneUsed.length) growDone()
  return true
}

function clearDone() {
  doneUsed.fill(0)
  doneCount = 0
  arenaLen = 0
}

/** Double the table of the current text's words. */
function growSeen() {
  const size = seenGen.length * 2
  const hash = new Int32Array(size)
  const start = new Int32Array(size)
  const len = new Int32Array(size)
  const g = new Int32Array(size)
  for (let i = 0; i < seenGen.length; i++) {
    if (seenGen[i] !== gen) continue
    let j = seenHash[i]! & (size - 1)
    while (g[j] === gen) j = (j + 1) & (size - 1)
    g[j] = gen
    hash[j] = seenHash[i]!
    start[j] = seenStart[i]!
    len[j] = seenLen[i]!
  }
  seenHash = hash
  seenStart = start
  seenLen = len
  seenGen = g
}

function growDone() {
  const size = doneUsed.length * 2
  const hash = new Int32Array(size)
  const start = new Int32Array(size)
  const len = new Int32Array(size)
  const used = new Uint8Array(size)
  for (let i = 0; i < doneUsed.length; i++) {
    if (!doneUsed[i]) continue
    let j = doneHash[i]! & (size - 1)
    while (used[j]) j = (j + 1) & (size - 1)
    used[j] = 1
    hash[j] = doneHash[i]!
    start[j] = doneStart[i]!
    len[j] = doneLen[i]!
  }
  doneHash = hash
  doneStart = start
  doneLen = len
  doneUsed = used
}
