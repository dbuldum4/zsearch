import { StyledText, TextAttributes, type TextChunk } from "@opentui/core"
import { rgba } from "./theme.ts"

export interface Seg {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

/** Terminal display width of a string (wide CJK/emoji count as 2). */
export function width(s: string): number {
  return Bun.stringWidth(s)
}

/** Truncate to `max` columns, adding an ellipsis. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return ""
  if (width(s) <= max) return s
  if (max === 1) return "…"
  let out = ""
  let w = 0
  for (const ch of s) {
    const cw = width(ch)
    if (w + cw > max - 1) break
    out += ch
    w += cw
  }
  return out + "…"
}

/** Truncate from the left: "…/deep/folder". */
export function truncateLeft(s: string, max: number): string {
  if (max <= 0) return ""
  if (width(s) <= max) return s
  if (max === 1) return "…"
  const chars = [...s]
  let out = ""
  let w = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = width(chars[i]!)
    if (w + cw > max - 1) break
    out = chars[i] + out
    w += cw
  }
  return "…" + out
}

export function pad(s: string, n: number): string {
  const w = width(s)
  return w >= n ? s : s + " ".repeat(n - w)
}

export function padLeft(s: string, n: number): string {
  const w = width(s)
  return w >= n ? s : " ".repeat(n - w) + s
}

export function toStyled(segs: Seg[]): StyledText {
  const chunks: TextChunk[] = []
  for (const s of segs) {
    if (!s.text) continue
    let attributes = 0
    if (s.bold) attributes |= TextAttributes.BOLD
    if (s.dim) attributes |= TextAttributes.DIM
    if (s.italic) attributes |= TextAttributes.ITALIC
    if (s.underline) attributes |= TextAttributes.UNDERLINE
    chunks.push({ __isChunk: true, text: s.text, fg: s.fg ? rgba(s.fg) : undefined, bg: s.bg ? rgba(s.bg) : undefined, attributes })
  }
  return new StyledText(chunks)
}

/**
 * Split `text` into segments, styling characters whose index is in `marks`
 * (sorted positions) or inside `ranges` with `hi`, the rest with `base`.
 */
export function highlight(text: string, base: Omit<Seg, "text">, hi: Omit<Seg, "text">, marks?: number[], ranges?: [number, number][]): Seg[] {
  if ((!marks || !marks.length) && (!ranges || !ranges.length)) return [{ text, ...base }]
  const on = new Uint8Array(text.length)
  for (const m of marks ?? []) if (m >= 0 && m < text.length) on[m] = 1
  for (const [a, b] of ranges ?? []) for (let i = Math.max(0, a); i < Math.min(text.length, b); i++) on[i] = 1
  const segs: Seg[] = []
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || on[i] !== on[start]) {
      segs.push({ text: text.slice(start, i), ...(on[start] ? hi : base) })
      start = i
    }
  }
  return segs
}

/** Fit segments into `max` columns (truncating the last visible segment with an ellipsis). */
export function fitSegs(segs: Seg[], max: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    const w = width(s.text)
    if (used + w <= max) {
      out.push(s)
      used += w
      continue
    }
    const rest = max - used
    if (rest > 0) out.push({ ...s, text: truncate(s.text, rest) })
    return out
  }
  return out
}

export function segsWidth(segs: Seg[]): number {
  return segs.reduce((n, s) => n + width(s.text), 0)
}

/** Shift highlight ranges after cutting `cut` characters from the left of a string. */
export function shiftRanges(ranges: [number, number][], cut: number): [number, number][] {
  return ranges.map(([a, b]) => [a - cut, b - cut] as [number, number]).filter(([, b]) => b > 0)
}

/** Wrap a line into rows of at most `cols` columns, keeping highlight ranges per row. */
export function wrapLine(text: string, ranges: [number, number][], cols: number, maxRows = 50): { text: string; ranges: [number, number][] }[] {
  if (cols <= 0) return [{ text: "", ranges: [] }]
  const rows: { text: string; ranges: [number, number][] }[] = []
  let start = 0
  const chars = text
  while (start < chars.length && rows.length < maxRows) {
    let w = 0
    let end = start
    let lastSpace = -1
    while (end < chars.length) {
      const cw = width(chars[end]!)
      if (w + cw > cols) break
      if (chars[end] === " ") lastSpace = end
      w += cw
      end++
    }
    if (end < chars.length && lastSpace > start + cols / 2) end = lastSpace + 1
    const rowRanges = ranges.map(([a, b]) => [Math.max(a, start) - start, Math.min(b, end) - start] as [number, number]).filter(([a, b]) => b > a)
    rows.push({ text: chars.slice(start, end), ranges: rowRanges })
    start = end
  }
  if (rows.length === 0) rows.push({ text: "", ranges: [] })
  return rows
}
