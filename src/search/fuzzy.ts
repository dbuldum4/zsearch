/**
 * fzf-style fuzzy matching (after junegunn/fzf's FuzzyMatchV1 and its scoring scheme):
 * characters must appear in order; matches at word boundaries, after path separators,
 * at camelCase humps and in consecutive runs score higher, gaps cost points.
 */

export const SCORE_MATCH = 16
const SCORE_GAP_START = -3
const SCORE_GAP_EXTENSION = -1
const BONUS_BOUNDARY = SCORE_MATCH / 2
const BONUS_NON_WORD = SCORE_MATCH / 2
const BONUS_CAMEL123 = BONUS_BOUNDARY + SCORE_GAP_EXTENSION
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION)
const BONUS_FIRST_CHAR_MULTIPLIER = 2
const BONUS_BOUNDARY_WHITE = BONUS_BOUNDARY + 2
const BONUS_BOUNDARY_DELIMITER = BONUS_BOUNDARY + 1

const enum C {
  White,
  NonWord,
  Delimiter,
  Lower,
  Upper,
  Letter,
  Number,
}

function charClass(code: number): C {
  if (code >= 97 && code <= 122) return C.Lower
  if (code >= 65 && code <= 90) return C.Upper
  if (code >= 48 && code <= 57) return C.Number
  if (code === 32 || code === 9 || code === 10) return C.White
  if (code === 47 || code === 44 || code === 58 || code === 59 || code === 124) return C.Delimiter // / , : ; |
  if (code < 128) return C.NonWord
  const ch = String.fromCharCode(code)
  if (/\p{Lu}/u.test(ch)) return C.Upper
  if (/\p{L}/u.test(ch)) return C.Letter
  if (/\p{N}/u.test(ch)) return C.Number
  if (/\s/.test(ch)) return C.White
  return C.NonWord
}

function bonusFor(prev: C, cls: C): number {
  if (cls > C.Delimiter) {
    if (prev === C.White) return BONUS_BOUNDARY_WHITE
    if (prev === C.Delimiter) return BONUS_BOUNDARY_DELIMITER
    if (prev === C.NonWord) return BONUS_BOUNDARY
  }
  if ((prev === C.Lower && cls === C.Upper) || (prev !== C.Number && cls === C.Number)) return BONUS_CAMEL123
  if (cls === C.NonWord || cls === C.Delimiter) return BONUS_NON_WORD
  if (cls === C.White) return BONUS_BOUNDARY_WHITE
  return 0
}

export interface FuzzyResult {
  score: number
  /** Matched character positions in the text. */
  positions: number[]
}

/**
 * Match lower-case `pattern` against `text` (original case) whose lower-case form is `lower`.
 * Searches within [from, text.length).
 */
export function fuzzyMatch(text: string, lower: string, pattern: string, from = 0, withPositions = true): FuzzyResult | null {
  const plen = pattern.length
  if (plen === 0) return { score: 0, positions: [] }
  // Forward pass: earliest end of an in-order match.
  let pidx = 0
  let sidx = -1
  let eidx = -1
  for (let i = from; i < lower.length; i++) {
    if (lower.charCodeAt(i) === pattern.charCodeAt(pidx)) {
      if (sidx < 0) sidx = i
      if (++pidx === plen) {
        eidx = i + 1
        break
      }
    }
  }
  if (eidx < 0) return null
  // Backward pass: tighten the start.
  pidx = plen - 1
  for (let i = eidx - 1; i >= sidx; i--) {
    if (lower.charCodeAt(i) === pattern.charCodeAt(pidx)) {
      if (--pidx < 0) {
        sidx = i
        break
      }
    }
  }
  return scoreWindow(text, lower, pattern, sidx, eidx, withPositions)
}

function scoreWindow(text: string, lower: string, pattern: string, sidx: number, eidx: number, withPositions: boolean): FuzzyResult {
  let score = 0
  let inGap = false
  let consecutive = 0
  let firstBonus = 0
  let pidx = 0
  const positions: number[] = []
  let prev = sidx > 0 ? charClass(text.charCodeAt(sidx - 1)) : C.Delimiter
  for (let i = sidx; i < eidx; i++) {
    const code = text.charCodeAt(i)
    const cls = charClass(code)
    if (pidx < pattern.length && lower.charCodeAt(i) === pattern.charCodeAt(pidx)) {
      if (withPositions) positions.push(i)
      score += SCORE_MATCH
      let bonus = bonusFor(prev, cls)
      if (consecutive === 0) firstBonus = bonus
      else {
        if (bonus >= BONUS_BOUNDARY && bonus > firstBonus) firstBonus = bonus
        bonus = Math.max(bonus, firstBonus, BONUS_CONSECUTIVE)
      }
      score += pidx === 0 ? bonus * BONUS_FIRST_CHAR_MULTIPLIER : bonus
      inGap = false
      consecutive++
      pidx++
    } else {
      score += inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START
      inGap = true
      consecutive = 0
      firstBonus = 0
    }
    prev = cls
  }
  return { score, positions }
}

/** Exact substring match (fzf's `'term`), scored like a fully consecutive fuzzy match. */
export function exactMatch(text: string, lower: string, pattern: string, from = 0): FuzzyResult | null {
  let best: FuzzyResult | null = null
  let idx = lower.indexOf(pattern, from)
  let tries = 0
  while (idx >= 0 && tries++ < 8) {
    const r = scoreWindow(text, lower, pattern, idx, idx + pattern.length, true)
    if (!best || r.score > best.score) best = r
    idx = lower.indexOf(pattern, idx + 1)
  }
  return best
}

/** One term of an fzf extended-search query. */
export interface FuzzyTerm {
  text: string
  kind: "fuzzy" | "exact" | "prefix" | "suffix" | "equal"
  negate: boolean
}

/** Parse fzf extended syntax: 'exact ^prefix suffix$ !negate, space-separated AND. */
export function parseFuzzyTerms(query: string): FuzzyTerm[] {
  const out: FuzzyTerm[] = []
  for (let tok of query.trim().split(/\s+/)) {
    if (!tok) continue
    let negate = false
    if (tok.startsWith("!") && tok.length > 1) {
      negate = true
      tok = tok.slice(1)
    }
    let kind: FuzzyTerm["kind"] = negate ? "exact" : "fuzzy"
    if (tok.startsWith("'") && tok.length > 1) {
      kind = "exact"
      tok = tok.slice(1)
    } else if (tok.startsWith("^") && tok.endsWith("$") && tok.length > 2) {
      kind = "equal"
      tok = tok.slice(1, -1)
    } else if (tok.startsWith("^") && tok.length > 1) {
      kind = "prefix"
      tok = tok.slice(1)
    } else if (tok.endsWith("$") && tok.length > 1) {
      kind = "suffix"
      tok = tok.slice(0, -1)
    }
    if (tok) out.push({ text: tok.toLowerCase(), kind, negate })
  }
  return out
}

/** Bitmask of the ASCII letters/digits in a lower-case string, for quick rejection. */
export function charMask(lower: string): number {
  let m = 0
  for (let i = 0; i < lower.length; i++) {
    const c = lower.charCodeAt(i)
    if (c >= 97 && c <= 122) m |= 1 << (c - 97)
    else if (c >= 48 && c <= 57) m |= 1 << 26
    else if (c === 46) m |= 1 << 27 // .
    else if (c === 95 || c === 45) m |= 1 << 28 // _ -
    else if (c === 47) m |= 1 << 29 // /
    else if (c > 127) m |= 1 << 30
  }
  return m
}

export interface PathMatch {
  score: number
  positions: number[]
}

/**
 * Match all terms against a display path whose basename starts at `nameStart`.
 * Matches inside the file name are preferred, the way fzf's path scheme does it.
 */
export function matchPath(path: string, lower: string, nameStart: number, terms: FuzzyTerm[], withPositions = true): PathMatch | null {
  let total = 0
  const positions: number[] = []
  for (const t of terms) {
    let r: FuzzyResult | null = null
    switch (t.kind) {
      case "fuzzy": {
        const inName = fuzzyMatch(path, lower, t.text, nameStart, true)
        if (inName) {
          r = inName
          r.score += 2 * t.text.length + 8
          // Whole-name and name-prefix matches are what people usually mean.
          const stemEnd = lower.lastIndexOf(".") > nameStart ? lower.lastIndexOf(".") : lower.length
          const consecutive = inName.positions.length > 0 && inName.positions[inName.positions.length - 1]! - inName.positions[0]! === t.text.length - 1
          if (consecutive && inName.positions[0] === nameStart) r.score += stemEnd - nameStart === t.text.length || lower.length - nameStart === t.text.length ? 40 : 16
        } else r = fuzzyMatch(path, lower, t.text, 0, withPositions)
        break
      }
      case "exact": {
        r = exactMatch(path, lower, t.text, nameStart)
        if (r) r.score += 2 * t.text.length + 8
        else r = exactMatch(path, lower, t.text)
        break
      }
      case "prefix": {
        if (lower.startsWith(t.text, nameStart)) r = scoreWindow(path, lower, t.text, nameStart, nameStart + t.text.length, true)
        else if (lower.startsWith(t.text)) r = scoreWindow(path, lower, t.text, 0, t.text.length, true)
        break
      }
      case "suffix": {
        if (lower.endsWith(t.text)) r = scoreWindow(path, lower, t.text, lower.length - t.text.length, lower.length, true)
        break
      }
      case "equal": {
        if (lower.slice(nameStart) === t.text) r = scoreWindow(path, lower, t.text, nameStart, lower.length, true)
        break
      }
    }
    if (t.negate) {
      if (r) return null
      continue
    }
    if (!r) return null
    total += r.score
    if (withPositions) for (const p of r.positions) positions.push(p)
  }
  if (withPositions) positions.sort((a, b) => a - b)
  return { score: total, positions }
}
