import { escapeRegExp, foldTerm } from "../util/text.ts"

export interface LineMatch {
  /** 1-based line number (lines are split on \n and \f). */
  line: number
  /** 1-based page / slide / sheet (count of \f before the line + 1). */
  page: number
  text: string
  ranges: [number, number][]
  /** Offset of the line start in the searched text. */
  offset?: number
}

const MAX_LINE = 240

/** Cut a long line down to a window around its first highlight. */
export function clipLine(text: string, ranges: [number, number][], width = MAX_LINE): { text: string; ranges: [number, number][] } {
  const clean = text.replace(/\t/g, " ")
  if (clean.length <= width) return { text: clean, ranges }
  const first = ranges[0]?.[0] ?? 0
  let start = Math.max(0, first - Math.floor(width / 3))
  if (start > 0) {
    const sp = clean.lastIndexOf(" ", start + 10)
    if (sp > start - 20 && sp >= 0) start = sp + 1
  }
  const end = Math.min(clean.length, start + width)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < clean.length ? "…" : ""
  const shift = prefix.length - start
  const out = ranges
    .map(([a, b]) => [Math.max(a, start) + shift, Math.min(b, end) + shift] as [number, number])
    .filter(([a, b]) => b > a)
  return { text: prefix + clean.slice(start, end) + suffix, ranges: out }
}

/**
 * Find lines matching `re` (must have the `g` flag) in `text`.
 * Returns up to `maxLines` lines with highlight ranges, plus the total match count.
 * `re` runs over `haystack`, a text of the same length whose matches are the text's (see `foldText`).
 * `total`, if given and it knows how many matches there are, lets the scan stop once the lines are found.
 */
export function findLines(
  text: string,
  re: Pick<RegExp, "exec" | "lastIndex">,
  maxLines = 50,
  maxMatches = 10_000,
  deadline = Infinity,
  clip = true,
  haystack = text,
  total?: () => number | undefined,
): { lines: LineMatch[]; count: number } {
  const lines: LineMatch[] = []
  let count = 0
  let lineNo = 1
  let page = 1
  let lineStart = 0
  // Next line break (\n) and page break (\f) at or after the scan position, found with native indexOf.
  let nextNl = -2
  let nextFf = -2
  const breakAfter = (pos: number): number => {
    if (nextNl !== -1 && nextNl < pos) nextNl = text.indexOf("\n", pos)
    if (nextFf !== -1 && nextFf < pos) nextFf = text.indexOf("\f", pos)
    if (nextNl === -1) return nextFf
    if (nextFf === -1) return nextNl
    return Math.min(nextNl, nextFf)
  }
  // Past an empty match by a whole character: a unicode regex steps back to the start of a
  // surrogate pair, so one unit on it would find the same empty match again.
  const skipEmpty = () => {
    const c = haystack.charCodeAt(re.lastIndex)
    const d = haystack.charCodeAt(re.lastIndex + 1)
    re.lastIndex += c >= 0xd800 && c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff ? 2 : 1
  }
  let current: LineMatch | null = null
  let currentStart = -1
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(haystack))) {
    if (m[0].length === 0) {
      skipEmpty()
      if (re.lastIndex > text.length) break
      continue
    }
    count++
    // Advance line counters to the match position.
    for (let b = breakAfter(lineStart); b !== -1 && b < m.index; b = breakAfter(lineStart)) {
      lineNo++
      if (text.charCodeAt(b) === 12) page++
      lineStart = b + 1
    }
    if (currentStart !== lineStart) {
      if (lines.length >= maxLines) {
        const n = total?.()
        if (n !== undefined) {
          count = Math.min(n, maxMatches)
          break
        }
        // Every snippet line is taken: from here on only the number of matches is needed.
        while (count < maxMatches && (m = re.exec(haystack))) {
          if (m[0].length === 0) {
            skipEmpty()
            if (re.lastIndex > text.length) break
            continue
          }
          count++
          if ((count & 1023) === 0 && Date.now() > deadline) break
        }
        break
      }
      const b = breakAfter(lineStart)
      const end = b === -1 ? text.length : b
      current = { line: lineNo, page, text: text.slice(lineStart, end), ranges: [], offset: lineStart }
      currentStart = lineStart
      lines.push(current)
    }
    if (current) {
      const lineEnd = lineStart + current.text.length
      current.ranges.push([m.index - lineStart, Math.min(m.index + m[0].length, lineEnd) - lineStart])
    }
    if (count >= maxMatches) break
    if ((count & 1023) === 0 && Date.now() > deadline) break
  }
  if (clip) {
    for (const l of lines) {
      const c = clipLine(l.text, l.ranges)
      l.text = c.text
      l.ranges = c.ranges
    }
  }
  return { lines, count }
}

/** Word-start regex for highlighting keyword hits; the last word may be a prefix while typing. */
export function termsPattern(words: string[], phrases: string[], prefixLast: boolean): string | null {
  const alts: string[] = []
  words.forEach((w, i) => {
    const tokens = foldTerm(w).match(/[\p{L}\p{N}]+/gu)
    if (!tokens) return
    const body = tokens.map(escapeRegExp).join("[^\\p{L}\\p{N}]+")
    const prefix = prefixLast && i === words.length - 1
    alts.push(`(?<![\\p{L}\\p{N}])${body}${prefix ? "" : "(?![\\p{L}\\p{N}])"}`)
  })
  for (const p of phrases) {
    const tokens = foldTerm(p).match(/[\p{L}\p{N}]+/gu)
    if (tokens) alts.push(`(?<![\\p{L}\\p{N}])${tokens.map(escapeRegExp).join("[^\\p{L}\\p{N}]+")}(?![\\p{L}\\p{N}])`)
  }
  if (!alts.length) return null
  // Longest alternatives first so phrases win over their words.
  alts.sort((a, b) => b.length - a.length)
  return alts.join("|")
}

/**
 * Accent variants are compiled once per query; document text stays untouched. Each letter has a
 * lower- and an upper-case class, so a case-sensitive pattern keeps its case; the `i` flag adds
 * the other case back. Variants the `i` flag cannot pair with a letter of the other case (`İ`,
 * `ẙ`) go in both, or case-insensitive patterns would miss them.
 */
const accents = new Map<string, { lower: string; upper: string }>()
for (const [start, end] of [[0xc0, 0x24f], [0x1e00, 0x1eff], [0x2c60, 0x2c7f], [0xa720, 0xa7ff], [0xab30, 0xab6f]]) {
  for (let cp = start!; cp <= end!; cp++) {
    const ch = String.fromCodePoint(cp)
    const folded = foldTerm(ch)
    if (!/^[a-z]$/.test(folded) || ch === folded) continue
    const cls = accents.get(folded) ?? { lower: folded, upper: folded.toUpperCase() }
    const upper = ch !== ch.toLowerCase()
    const other = upper ? ch.toLowerCase() : ch.toUpperCase()
    const paired = other.length === ch.length && other !== ch && new RegExp(`^${ch}$`, "iu").test(other)
    if (upper || !paired) cls.upper += ch
    if (!upper || !paired) cls.lower += ch
    accents.set(folded, cls)
  }
}
const patterns = new Map<string, string>()
export function diacriticPattern(pattern: string): string {
  const cached = patterns.get(pattern)
  if (cached !== undefined) return cached
  let out = "", bracket = false
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === "\\") {
      out += ch + (pattern[++i] ?? "")
      if ((pattern[i] === "p" || pattern[i] === "P") && pattern[i + 1] === "{") {
        const end = pattern.indexOf("}", i + 2)
        if (end >= 0) { out += pattern.slice(i + 1, end + 1); i = end }
      }
    } else if (ch === "[") { bracket = true; out += ch }
    else if (ch === "]") { bracket = false; out += ch }
    else if (!bracket && /^[a-z]$/.test(foldTerm(ch))) {
      const cls = accents.get(foldTerm(ch))
      const same = cls ? (ch !== ch.toLowerCase() ? cls.upper : cls.lower) : ""
      out += `[${same.includes(ch) ? same : ch + same}]\\p{M}*`
    }
    else out += ch
  }
  if (patterns.size >= 128) patterns.clear()
  patterns.set(pattern, out)
  return out
}

/** `folded`: the text's `foldText`, if known. */
export function keywordLines(text: string, pattern: string, maxLines = 50, clip = true, maxMatches = 10_000, folded?: Folded): { lines: LineMatch[]; count: number } {
  const fast = foldedPattern(pattern)
  if (!fast) return findLines(text, new RegExp(diacriticPattern(pattern), "giu"), maxLines, maxMatches, Infinity, clip)
  const f = folded ?? foldText(text)
  const words = fast.words
  // After a combining mark a word may go on or another may start, so in a text with marks two
  // words' matches can overlap or start at the same place, and their counts don't add up.
  if (!words || f.marked) return findLines(text, fast.re, maxLines, maxMatches, Infinity, clip, f.text)
  // The count is each word's, added up: once every word's count in the text is known, the scan
  // stops when the lines are found. A scan of the whole text learns its words' counts.
  const re = fast.re
  const seen = new Map<string, number>()
  const tally = {
    get lastIndex() { return re.lastIndex },
    set lastIndex(i: number) { re.lastIndex = i },
    exec(s: string) {
      const m = re.exec(s)
      if (m) seen.set(m[0], (seen.get(m[0]) ?? 0) + 1)
      return m
    },
  }
  let stopped = false
  const found = findLines(text, tally, maxLines, maxMatches, Infinity, clip, f.text, () => {
    let n = 0
    for (const w of words) {
      const k = f.known(w)
      if (k === undefined) return undefined
      n += k
    }
    stopped = true
    return n
  })
  if (!stopped && found.count < maxMatches) for (const w of words) f.counted(w, seen.get(w.word) ?? 0)
  return found
}

/* ---------------------------------------------- folded keyword search -- */

/*
 * The patterns `termsPattern` makes, compiled by `diacriticPattern` with the `iu` flags, read
 * each character as one of: a letter that matches a-z (in any case, with any accent), a combining
 * mark, another letter or number, or anything else. A text's *folded* form says which, one byte
 * per UTF-16 unit: a-z, ASCII digits, MARK, LETTER, or the character itself (ASCII) or a space.
 * Its matches are the same as the text's, at the same places, with the same lengths, and a plain
 * ASCII regex finds them several times faster than the accented one finds them in the text.
 */
const MARK = 1
const LETTER = 2
/** The second half of a mark that takes two UTF-16 units: no match may end between them. */
const MARK_TAIL = 3
let foldTable: Uint8Array | null = null

function table(): Uint8Array {
  if (foldTable) return foldTable
  const t = new Uint8Array(0x10000)
  const letters = "abcdefghijklmnopqrstuvwxyz"
  const classes = [...letters].map((x) => new RegExp(`^${diacriticPattern(x).replace("\\p{M}*", "")}$`, "iu"))
  const any = new RegExp(`^[${[...letters].map((x) => diacriticPattern(x).replace("\\p{M}*", "").slice(1, -1)).join("")}]$`, "iu")
  const mark = /^\p{M}$/u
  const word = /^[\p{L}\p{N}]$/u
  for (let c = 0; c < 0x10000; c++) {
    if (c >= 0xd800 && c <= 0xdfff) { t[c] = 32; continue }
    const ch = String.fromCharCode(c)
    if (any.test(ch)) {
      const k = classes.findIndex((re) => re.test(ch))
      t[c] = 97 + k
    } else if (c < 128) t[c] = c === MARK || c === LETTER || c === MARK_TAIL ? 32 : c
    else t[c] = mark.test(ch) ? MARK : word.test(ch) ? LETTER : 32
  }
  return (foldTable = t)
}

const latin1 = new TextDecoder("latin1")

/** A text's folded form (see above), and how many times words are in it, once scans have found out. */
export class Folded {
  private counts = new Map<string, number>()
  private hasMarks: boolean | undefined

  constructor(readonly text: string) {}

  /** Whether the text has combining marks. */
  get marked(): boolean {
    return (this.hasMarks ??= /[\x01\x03]/.test(this.text))
  }

  /** How many times `w` matches in the text, if a scan of the whole text found out. */
  known(w: Word): number | undefined {
    return this.counts.get(w.prefix ? `${w.word}*` : w.word)
  }

  /** `w` was found `n` times in a scan of the whole text. */
  counted(w: Word, n: number) {
    this.counts.set(w.prefix ? `${w.word}*` : w.word, n)
  }
}

export function foldText(text: string): Folded {
  const t = table()
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0xd800 || c > 0xdfff) {
      out[i] = t[c]!
      continue
    }
    // A surrogate pair is one character to the patterns: both halves say what it is.
    const d = c <= 0xdbff && i + 1 < text.length ? text.charCodeAt(i + 1) : 0
    if (d >= 0xdc00 && d <= 0xdfff) {
      const ch = String.fromCharCode(c, d)
      const f = /^\p{M}$/u.test(ch) ? MARK : /^[\p{L}\p{N}]$/u.test(ch) ? LETTER : 32
      out[i] = f
      out[i + 1] = f === MARK ? MARK_TAIL : f
      i++
    } else out[i] = 32
  }
  return new Folded(latin1.decode(out))
}

/** A word of a pattern, matched only whole unless it is a `prefix`, and its alternative of the folded pattern. */
type Word = { word: string; prefix: boolean }

const foldedPatterns = new Map<string, { re: RegExp; words: Word[] | null } | null>()
const ALT = /^\(\?<!\[\\p\{L\}\\p\{N\}\]\)([a-z0-9]+(?:\[\^\\p\{L\}\\p\{N\}\]\+[a-z0-9]+)*)(\(\?!\[\\p\{L\}\\p\{N\}\]\))?$/

/**
 * A `termsPattern` pattern for folded text, and its words when they are single words no two of
 * which can match at the same place (one a prefix of the other). Null for any other pattern, or
 * one with words outside a-z and digits.
 */
function foldedPattern(pattern: string): { re: RegExp; words: Word[] | null } | null {
  const cached = foldedPatterns.get(pattern)
  if (cached !== undefined) return cached
  let out: { re: RegExp; words: Word[] | null } | null = null
  const alts = pattern.split("|").map((a) => ALT.exec(a))
  if (alts.every((m) => m)) {
    const word = "a-z0-9\\x02"
    const letters = (t: string) => t.replace(/[a-z]/g, "$&[\\x01\\x03]*")
    const sources = alts.map((m) => `(?<![${word}])${m![1]!.split("[^\\p{L}\\p{N}]+").map(letters).join(`[^${word}]+`)}${m![2] ? `(?![${word}\\x03])` : ""}`)
    const re = new RegExp(sources.join("|"), "g")
    let words: Word[] | null = null
    if (alts.every((m) => !m![1]!.includes("["))) {
      // In a text without marks a match lies within one word, and no other can start inside it: the pattern's matches
      // are its words' matches, unless two words can match at the same place.
      const seen = new Map<string, Word>()
      for (const m of alts) seen.set(`${m![1]}${m![2] ? "" : "*"}`, { word: m![1]!, prefix: !m![2] })
      words = [...seen.values()]
      if (words.some((a) => a.prefix && words!.some((b) => b !== a && b.word.startsWith(a.word)))) words = null
    }
    out = { re, words }
  }
  if (foldedPatterns.size >= 128) foldedPatterns.clear()
  foldedPatterns.set(pattern, out)
  return out
}

export function splitLines(text: string): string[] {
  return text.split(/\n|\f/)
}
