import { KIND_BADGE } from "../kinds.ts"
import type { Preview, SearchHit } from "../search/engine.ts"
import { formatAge, formatBytes, formatDate } from "../util/text.ts"
import { fitSegs, highlight, pad, padLeft, type Seg, segsWidth, truncate, truncateLeft, width, wrapLine } from "./styled.ts"
import type { Theme } from "./theme.ts"

export interface Row {
  key: string
  segs: Seg[]
  bg?: string
  /** Result index this row belongs to (results list), or -1. */
  hit: number
}

export function hitHeight(h: SearchHit): number {
  return h.lines.length ? 2 : 1
}

/** Keep the selected item visible; returns the new scroll offset (in items). */
export function clampScroll(hits: SearchHit[], selected: number, top: number, height: number): number {
  if (!hits.length) return 0
  selected = Math.min(Math.max(0, selected), hits.length - 1)
  let t = Math.min(Math.max(0, top), selected)
  // Advance `t` until the selected item's bottom fits.
  for (;;) {
    let used = 0
    for (let i = t; i <= selected; i++) used += hitHeight(hits[i]!)
    if (used <= height || t >= selected) break
    t++
  }
  // Don't leave empty rows at the bottom when earlier items would fit.
  let below = 0
  for (let i = t; i < hits.length && below <= height; i++) below += hitHeight(hits[i]!)
  while (t > 0 && below + hitHeight(hits[t - 1]!) <= height) {
    t--
    below += hitHeight(hits[t]!)
  }
  return t
}

function locationLabel(h: SearchHit, line: { line: number; page: number }): string {
  switch (h.kind) {
    case "pdf":
    case "ebook":
      return `p.${line.page}`
    case "slides":
      return `slide ${line.page}`
    case "sheet":
      return `sheet ${line.page}`
    default:
      return `L${line.line}`
  }
}

export function resultRows(hits: SearchHit[], selected: number, top: number, cols: number, rows: number, theme: Theme): Row[] {
  const out: Row[] = []
  for (let i = top; i < hits.length && out.length < rows; i++) {
    const h = hits[i]!
    const sel = i === selected
    const bg = sel ? theme.selection : undefined
    const nameStart = h.display.lastIndexOf("/") + 1
    const name = h.display.slice(nameStart) + (h.isDir ? "/" : "")
    const dir = nameStart > 0 ? h.display.slice(0, nameStart - 1) : ""
    const namePos = h.namePositions.filter((p) => p >= nameStart).map((p) => p - nameStart)
    const dirPos = h.namePositions.filter((p) => p < nameStart - 1)
    const kindColor = theme.kinds[h.kind] ?? theme.text
    const lead: Seg[] = [
      { text: sel ? "▌" : " ", fg: theme.accent },
      { text: pad(KIND_BADGE[h.kind], 5), fg: kindColor, bold: true },
    ]
    const nameSegs = highlight(name, { fg: theme.text, bold: true }, { fg: theme.match, bold: true, underline: true }, namePos)
    const meta = cols >= 70 ? `${h.isDir ? "" : formatBytes(h.size).padStart(7)}  ${formatAge(h.mtime).padStart(8)} ` : ""
    const avail = cols - segsWidth(lead) - width(meta)
    const fittedName = fitSegs(nameSegs, Math.max(4, avail))
    const used = segsWidth(lead) + segsWidth(fittedName)
    const dirRoom = cols - used - width(meta) - 2
    let dirSegs: Seg[] = []
    if (dir && dirRoom > 3) {
      const shown = truncateLeft(dir, dirRoom)
      const cut = dir.length - (shown.startsWith("…") ? shown.length - 1 : shown.length)
      const ranges = dirPos.map((p) => p - cut + (shown.startsWith("…") ? 1 : 0)).filter((p) => p >= 0)
      dirSegs = [{ text: "  " }, ...highlight(shown, { fg: theme.subtle }, { fg: theme.match }, ranges)]
    }
    const line1 = [...lead, ...fittedName, ...dirSegs]
    const gap = Math.max(0, cols - segsWidth(line1) - width(meta))
    line1.push({ text: " ".repeat(gap) }, { text: meta, fg: theme.subtle })
    out.push({ key: `${h.id}:0`, segs: line1, bg, hit: i })
    if (h.lines.length && out.length < rows) {
      const l = h.lines[0]!
      const label = `${locationLabel(h, l)}${h.matchCount > 1 ? ` (+${h.matchCount - 1})` : ""}  `
      const text = l.text.replace(/\s+/g, " ")
      const leftTrim = text.length - text.trimStart().length
      const body = highlight(
        text.trimStart(),
        { fg: theme.muted },
        { fg: theme.match, bg: theme.matchBg, bold: true },
        undefined,
        l.ranges.map(([a, b]) => [a - leftTrim, b - leftTrim]),
      )
      const segs: Seg[] = [{ text: "      " }, { text: label, fg: theme.subtle }, ...body]
      out.push({ key: `${h.id}:1`, segs: fitSegs(segs, cols), bg, hit: i })
    }
  }
  return out
}

/* ---------------------------------------------------------------- preview -- */

const PAGE_WORD: Record<string, string> = { pdf: "page", slides: "slide", sheet: "sheet", ebook: "chapter" }

export interface PreviewLayout {
  header: Row[]
  body: Row[]
  /** Visual row index of the focus line within `body`. */
  focusRow: number
}

export function previewLayout(p: Preview, cols: number, theme: Theme, wrap: boolean): PreviewLayout {
  const header: Row[] = []
  const titleSegs: Seg[] = [
    { text: ` ${KIND_BADGE[p.kind]} `, fg: theme.accentText, bg: theme.kinds[p.kind] ?? theme.accent, bold: true },
    { text: " " },
    { text: truncateLeft("~/" + p.display.replace(/^~\/?/, ""), cols - 8), fg: theme.text, bold: true },
  ]
  if (p.display.startsWith("/")) titleSegs[2] = { text: truncateLeft(p.display, cols - 8), fg: theme.text, bold: true }
  header.push({ key: "title", segs: fitSegs(titleSegs, cols), hit: -1 })
  const meta: string[] = []
  if (!p.isDir) meta.push(formatBytes(p.size))
  meta.push(`modified ${formatDate(p.mtime)} (${formatAge(p.mtime)})`)
  if (p.pageStarts.length > 1) meta.push(`${p.pageStarts.length} ${PAGE_WORD[p.kind] ?? "section"}s`)
  if (p.matchLines.length) meta.push(`${p.matchLines.length}${p.matchLines.length >= 2000 ? "+" : ""} matching line${p.matchLines.length === 1 ? "" : "s"}`)
  if (p.isDir) meta.push(`${p.totalLines} item${p.totalLines === 1 ? "" : "s"}`)
  if (p.source === "disk" && !p.isDir) meta.push("read from disk")
  if (p.note === "truncated") meta.push("text truncated")
  header.push({ key: "meta", segs: [{ text: truncate(" " + meta.join(" · "), cols), fg: theme.subtle }], hit: -1 })
  header.push({ key: "sep", segs: [{ text: "─".repeat(Math.max(0, cols)), fg: theme.faint }], hit: -1 })

  const body: Row[] = []
  let focusRow = 0
  if (p.message && !p.lines.length) {
    body.push({ key: "msg-pad", segs: [{ text: "" }], hit: -1 })
    body.push({ key: "msg", segs: [{ text: truncate(`  ${p.message}`, cols), fg: theme.subtle, italic: true }], hit: -1 })
    return { header, body, focusRow }
  }
  if (p.isDir) {
    for (const l of p.lines) {
      const isDir = l.text.endsWith("/")
      body.push({ key: `d${l.n}`, segs: [{ text: truncate(`  ${l.text}`, cols), fg: isDir ? theme.kinds.folder : theme.text, bold: isDir }], hit: -1 })
    }
    if (p.totalLines > p.lines.length) body.push({ key: "more", segs: [{ text: `  … ${p.totalLines - p.lines.length} more`, fg: theme.subtle }], hit: -1 })
    return { header, body, focusRow }
  }
  const lastN = p.lines.length ? p.lines[p.lines.length - 1]!.n : 1
  const gutter = Math.max(3, String(lastN).length)
  const textCols = Math.max(8, cols - gutter - 3)
  const pageSet = new Map<number, number>()
  p.pageStarts.forEach((line, i) => pageSet.set(line, i + 1))
  const matchSet = new Set(p.matchLines)
  for (const l of p.lines) {
    const page = pageSet.get(l.n)
    if (page !== undefined && page > 1) {
      const label = ` ${PAGE_WORD[p.kind] ?? "section"} ${page} `
      const side = Math.max(2, Math.floor((cols - label.length) / 2))
      body.push({ key: `pg${l.n}`, segs: [{ text: "┄".repeat(side) + label + "┄".repeat(Math.max(0, cols - side - label.length)), fg: theme.faint }], hit: -1 })
    }
    if (l.n === p.focusLine) focusRow = body.length
    const isMatch = matchSet.has(l.n)
    const isFocus = l.n === p.focusLine
    const num = padLeft(String(l.n), gutter)
    const text = l.text.replace(/\t/g, "  ")
    // Tabs expand to two spaces: shift ranges accordingly.
    const ranges = expandTabRanges(l.text, l.ranges)
    const pieces = wrap ? wrapLine(text, ranges, textCols, 40) : [{ text: truncate(text, textCols), ranges }]
    pieces.forEach((piece, k) => {
      const gut: Seg = { text: `${k === 0 ? num : " ".repeat(gutter)} ${k === 0 && isFocus ? "▶" : "│"} `, fg: isFocus ? theme.accent : isMatch ? theme.match : theme.faint }
      const segs = [gut, ...highlight(piece.text, { fg: theme.text }, { fg: theme.match, bg: theme.matchBg, bold: true }, undefined, piece.ranges)]
      body.push({ key: `l${l.n}.${k}`, segs: fitSegs(segs, cols), hit: -1 })
    })
  }
  if (p.lines.length && lastN < p.totalLines) body.push({ key: "tail", segs: [{ text: `  … ${p.totalLines - lastN} more lines`, fg: theme.subtle }], hit: -1 })
  return { header, body, focusRow }
}

function expandTabRanges(text: string, ranges: [number, number][]): [number, number][] {
  if (!text.includes("\t") || !ranges.length) return ranges
  const map: number[] = []
  let o = 0
  for (let i = 0; i <= text.length; i++) {
    map.push(o)
    o += text[i] === "\t" ? 2 : 1
  }
  return ranges.map(([a, b]) => [map[a] ?? a, map[b] ?? b])
}
