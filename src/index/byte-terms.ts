/**
 * The index terms of a UTF-8 text, straight from its bytes: most files are plain ASCII or
 * nearly so, and decoding them, lower-casing them and making a string of every word costs more
 * than the rest of their extraction. The result is what `indexTerms` gives for the decoded text
 * (see there).
 */
import { isUtf8 } from "node:buffer"
import { uniqueTerms } from "../util/text.ts"

/**
 * Per byte: 0 between words, BAD for NUL (which extraction drops), else the byte the word holds:
 * ASCII letters lower-cased, and bytes of other characters as they are. Only ASCII characters
 * other than letters and digits separate words, as in `indexTerms`.
 */
const BAD = 1
const CLASS = new Uint8Array(256)
for (let b = 0; b < 256; b++) {
  if (b === 0) CLASS[b] = BAD
  else if ((b >= 97 && b <= 122) || (b >= 48 && b <= 57) || b >= 0x80) CLASS[b] = b
  else if (b >= 65 && b <= 90) CLASS[b] = b | 0x20
}

/**
 * Distinct words of a text, by where they first occur in it: a table started over for each
 * text. Each slot is four numbers side by side (generation, hash, start, length), so that a
 * lookup reads one cache line.
 */
let seen = new Int32Array(4096 * 4)
let gen = 0
/** The hash of each distinct word of the text, in order. */
let wordHash = new Int32Array(4096)

/** Words already reported this run, kept in `arena`: slots of (used, hash, start, length). */
let done = new Int32Array((1 << 16) * 4)
let doneCount = 0
let arena = new Uint8Array(1 << 20)
let arenaLen = 0
let doneRun = ""
/** Reported terms of words with other characters than ASCII ones, as strings: they are few. */
const doneWide = new Set<string>()
const NO_WORDS = new Int32Array(0)
/** As for the other texts' terms (see extract-job.ts): reporting a few twice does no harm. */
const MAX_DONE = 250_000

const latin1 = new TextDecoder("latin1")
const utf8 = new TextDecoder()

export interface ByteTerms {
  /** The distinct words, ASCII letters lower-cased, separated by spaces: the FTS body, in UTF-8. */
  body: Uint8Array
  /** How many more bytes the text has than UTF-16 code units: its length is the bytes' less this. */
  wide: number
  /**
   * Terms not reported before during `run`, which they now count as (see `uniqueTerms`).
   * Called once the result is sure to reach the indexer, and before the next `byteTerms`.
   */
  report(): string[]
}

/**
 * Null when the bytes are not plain UTF-8 text that `indexTerms` would read the same: NUL bytes
 * (extraction drops them), a byte order mark, invalid UTF-8, or no ASCII word at all (the text
 * may be only white space other than ASCII, which extraction takes as empty).
 */
export function byteTerms(buf: Uint8Array, run: string): ByteTerms | null {
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
  /** Distinct words with other bytes than ASCII ones, by number, and their count. */
  let wideWords = NO_WORDS
  let wideCount = 0
  /** Bytes other than ASCII ones: UTF-8 continuation bytes, and the lead bytes of 4-byte characters. */
  let cont = 0
  let lead4 = 0
  let asciiWord = false
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return null
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
    let wide = false
    do {
      h = Math.imul(h ^ c, 0x01000193)
      out[o++] = c
      if (c >= 0x80) {
        wide = true
        if (c < 0xc0) cont++
        else if (c >= 0xf0) lead4++
      }
      c = ++i < n ? CLASS[buf[i]!]! : 0
    } while (c > BAD)
    if (!wide) asciiWord = true
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
    if (words === wordHash.length) {
      const bigger = new Int32Array(words * 2)
      bigger.set(wordHash)
      wordHash = bigger
    }
    wordHash[words] = h
    if (wide) {
      if (wideCount === wideWords.length) {
        const bigger = new Int32Array(Math.max(64, wideCount * 2))
        bigger.set(wideWords)
        wideWords = bigger
      }
      wideWords[wideCount++] = words
    }
    if (++words * 2 > mask + 1) growSeen()
    if (at) out[at - 1] = 0x20
    outLen = o
  }
  if (wideCount && (!asciiWord || !isUtf8(buf))) return null
  // Only once the text is known to be plain, and its result sure to be sent: a word reported for
  // a text that then takes the other path (where it may be part of a longer word), or fails,
  // would never be reported again.
  const report = () => {
    const fresh: string[] = []
    for (let k = 0, at = 0, w = 0; k < words; k++) {
      const end = k === words - 1 ? outLen : out.indexOf(0x20, at)
      const len = end - at
      if (w < wideCount && wideWords[w] === k) {
        // Characters other than ASCII ones may still separate words, or fold: as `indexTerms` does.
        w++
        for (const t of uniqueTerms(utf8.decode(out.subarray(at, end)))) {
          if (ASCII_TERM.test(t)) {
            if (markAscii(t)) fresh.push(t)
            continue
          }
          if (doneWide.has(t)) continue
          if (doneWide.size >= MAX_DONE) doneWide.clear()
          doneWide.add(t)
          fresh.push(t)
        }
      } else if (len <= 64 && markReported(out, at, len, wordHash[k]!)) fresh.push(latin1.decode(out.subarray(at, end)))
      at = end + 1
    }
    return fresh
  }
  return { body: out.slice(0, outLen), wide: cont - lead4, report }
}

const ASCII_TERM = /^[a-z0-9]+$/
let scratch = new Uint8Array(64)

/** `markReported` for an ASCII term given as a string. */
function markAscii(t: string): boolean {
  if (scratch.length < t.length) scratch = new Uint8Array(t.length)
  let h = 0x811c9dc5 | 0
  for (let k = 0; k < t.length; k++) {
    const c = t.charCodeAt(k)
    scratch[k] = c
    h = Math.imul(h ^ c, 0x01000193)
  }
  return markReported(scratch, 0, t.length, h)
}

function same(a: Uint8Array, i: number, b: Uint8Array, j: number, len: number): boolean {
  for (let k = 0; k < len; k++) if (a[i + k] !== b[j + k]) return false
  return true
}

/** Record a lower-cased word as reported; false if it was already. */
function markReported(word: Uint8Array, at: number, len: number, h: number): boolean {
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
  doneWide.clear()
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
