/**
 * How a file's stored text is cut into the passages semantic search embeds, and the text each
 * passage goes to the model as.
 *
 * Passages hold up to CHUNK_CHARS characters (DigUp's size, about 450 tokens) of whole
 * paragraphs or lines. Where they end is decided by the text itself: a passage may end after a
 * paragraph only where a hash of that paragraph says so, or when the next one would not fit. So
 * an edit moves the boundaries near it only, and the passages before and after it come out the
 * same, with the same hashes, and keep their vectors (see `indexer.ts`). Unlike DigUp, passages
 * don't overlap: cutting at paragraphs leaves little to gain from it, for 11% more tokens.
 */

/** Characters in a passage, at most (DigUp's 1,800). */
export const CHUNK_CHARS = 1800
/** A passage may end early, at a paragraph the hash picks, once it holds this many. */
const MIN_CHARS = 1200
/** Bump when the cutting or the model text changes: every passage is embedded again. */
export const CHUNKER_VERSION = 1

export interface Chunk {
  /** Where the passage starts and ends in the stored text (UTF-16 offsets). */
  start: number
  end: number
  text: string
}

/** FNV-1a of a string, for picking boundaries: cheap and stable, nothing more. */
function fnv(s: string, from: number, to: number): number {
  let h = 0x811c9dc5
  for (let i = from; i < to; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * The pieces a passage is made of: paragraphs (or pages), and lines of paragraphs too long to
 * fit, and runs of words of lines too long to fit. Each is [start, end) in `text`, whitespace
 * between them left out.
 */
function pieces(text: string): [number, number][] {
  const out: [number, number][] = []
  const push = (from: number, to: number) => {
    while (from < to && /\s/.test(text[from]!)) from++
    while (to > from && /\s/.test(text[to - 1]!)) to--
    if (to <= from) return
    if (to - from <= CHUNK_CHARS) return void out.push([from, to])
    // Too long: its lines, or failing that, runs of words.
    const nl = text.indexOf("\n", from)
    if (nl >= 0 && nl < to - 1) {
      let s = from
      for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) { push(s, i); s = i + 1 }
      push(s, to)
      return
    }
    let s = from
    while (s < to) {
      let e = Math.min(to, s + CHUNK_CHARS)
      if (e < to) {
        const space = text.lastIndexOf(" ", e)
        if (space > s + CHUNK_CHARS / 2) e = space
      }
      push(s, e)
      s = e
    }
  }
  // Paragraphs end at a blank line or a page break.
  const re = /\n[ \t]*\n|\f/g
  let start = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    push(start, m.index)
    start = m.index + m[0].length
  }
  push(start, text.length)
  return out
}

/** Cut `text` into passages, at most `max` of them. */
export function chunkText(text: string, max = Infinity): Chunk[] {
  const out: Chunk[] = []
  let first = -1
  let last = -1
  const close = () => {
    if (first < 0) return
    out.push({ start: first, end: last, text: text.slice(first, last).replace(/[ \t ]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n") })
    first = -1
  }
  for (const [s, e] of pieces(text)) {
    if (out.length >= max) break
    if (first >= 0 && e - first > CHUNK_CHARS) close()
    if (out.length >= max) break
    if (first < 0) first = s
    last = e
    if (last - first >= MIN_CHARS && (fnv(text, s, e) & 3) === 0) close()
  }
  if (out.length < max) close()
  return out
}

/**
 * Mostly digits and symbols (a table, a data dump, a hash list): such text goes to keyword
 * search only. As DigUp's `SearchText.hasWords`: letters at least a fifth of what isn't space.
 */
export function hasWords(text: string): boolean {
  let letters = 0
  let others = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // ASCII without a regular expression: most text is.
    if (c < 128) {
      if (c === 32 || (c >= 9 && c <= 13)) continue
      if ((c | 32) >= 97 && (c | 32) <= 122) letters++
      else others++
      continue
    }
    const cp = text.codePointAt(i)!
    if (cp > 0xffff) i++
    const ch = String.fromCodePoint(cp)
    if (/\s/.test(ch)) continue
    if (/\p{L}/u.test(ch)) letters++
    else others++
  }
  return letters > 0 && letters * 4 >= others
}

/**
 * The title a file's passages go to the model with: its name without the extension, and without
 * the marks of a copy ("report (1).pdf", "report copy.pdf"), so that copies of a file share their
 * passages' vectors.
 */
export function titleOf(name: string): string {
  const dot = name.lastIndexOf(".")
  let stem = dot > 0 ? name.slice(0, dot) : name
  stem = stem.replace(/(?:\s*\(\d+\)|\s+copy(?:\s+\d+)?|\s+-\s+Copy(?:\s+\(\d+\))?)+$/i, "")
  return stem.trim() || name
}

/**
 * The text a passage is embedded as: its file's title, then the passage. Neither model takes a
 * prompt (Granite's model card uses none).
 */
export function documentPrompt(title: string, text: string): string {
  return title ? `${title}\n\n${text}` : text
}

/** The text a query is embedded as: itself. */
export function queryPrompt(text: string): string {
  return text
}
