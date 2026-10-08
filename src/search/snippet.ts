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
 */
export function findLines(
  text: string,
  re: RegExp,
  maxLines = 50,
  maxMatches = 10_000,
  deadline = Infinity,
  clip = true,
): { lines: LineMatch[]; count: number } {
  const lines: LineMatch[] = []
  let count = 0
  let lineNo = 1
  let page = 1
  let scanPos = 0
  let lineStart = 0
  let current: LineMatch | null = null
  let currentStart = -1
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++
      if (re.lastIndex > text.length) break
      continue
    }
    count++
    // Advance line counters to the match position.
    for (let i = scanPos; i < m.index; i++) {
      const c = text.charCodeAt(i)
      if (c === 10 || c === 12) {
        lineNo++
        lineStart = i + 1
        if (c === 12) page++
      }
    }
    scanPos = m.index
    if (currentStart !== lineStart) {
      if (lines.length >= maxLines) {
        if (count >= maxMatches || Date.now() > deadline) break
        continue
      }
      let end = lineStart
      while (end < text.length && text.charCodeAt(end) !== 10 && text.charCodeAt(end) !== 12) end++
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

/** Fold a string (lower-case, no diacritics) keeping a map back to original offsets. */
export function foldWithMap(s: string): { folded: string; map: number[] } {
  let folded = ""
  const map: number[] = []
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    const f = cp < 128 ? ch.toLowerCase() : foldTerm(ch)
    for (let k = 0; k < f.length; k++) map.push(i)
    folded += f
    i += ch.length
  }
  map.push(s.length)
  return { folded, map }
}

/**
 * Lines of `text` that contain keyword hits. Matching runs on folded text so that
 * "cafe" highlights "Café"; ranges are mapped back to the original characters.
 */
export function keywordLines(text: string, pattern: string, maxLines = 50): { lines: LineMatch[]; count: number } {
  if (!/[^\x00-\x7f]/.test(text)) return findLines(text, new RegExp(pattern, "giu"), maxLines)
  const { folded, map } = foldWithMap(text)
  const r = findLines(folded, new RegExp(pattern, "gu"), maxLines, 10_000, Infinity, false)
  const lines = r.lines.map((l) => {
    const off = l.offset ?? 0
    const origStart = map[off] ?? 0
    let origEnd = origStart
    while (origEnd < text.length && text.charCodeAt(origEnd) !== 10 && text.charCodeAt(origEnd) !== 12) origEnd++
    const ranges = l.ranges.map(([a, b]) => [(map[off + a] ?? origStart) - origStart, (map[off + b] ?? origEnd) - origStart] as [number, number])
    const c = clipLine(text.slice(origStart, origEnd), ranges)
    return { line: l.line, page: l.page, text: c.text, ranges: c.ranges }
  })
  return { lines, count: r.count }
}

export function splitLines(text: string): string[] {
  return text.split(/\n|\f/)
}

/** Page number (1-based) of a character offset. */
export function pageAt(text: string, offset: number): number {
  let p = 1
  let i = text.indexOf("\f")
  while (i >= 0 && i < offset) {
    p++
    i = text.indexOf("\f", i + 1)
  }
  return p
}

/** Line number (1-based, \n and \f both break lines) of a character offset. */
export function lineAt(text: string, offset: number): number {
  let n = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 10 || c === 12) n++
  }
  return n
}
