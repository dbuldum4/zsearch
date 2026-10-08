export interface Chunk {
  start: number
  end: number
}

export interface ChunkOptions {
  target: number
  max: number
  overlap: number
  maxChunks: number
}

export const DEFAULT_CHUNKING: ChunkOptions = { target: 900, max: 1400, overlap: 120, maxChunks: 48 }

const BREAKS: RegExp[] = [/\n\s*\n/g, /\f/g, /\n/g, /[.!?。！？]\s/g, /[;:,]\s/g, /\s/g]

function findBreak(text: string, from: number, to: number): number {
  const window = text.slice(from, to)
  for (const re of BREAKS) {
    re.lastIndex = 0
    let last = -1
    let m: RegExpExecArray | null
    while ((m = re.exec(window))) last = m.index + m[0].length
    if (last > 0) return from + last
  }
  return to
}

/**
 * Split text into overlapping passages that end on natural boundaries (paragraphs,
 * sentences, words). Long documents are sampled evenly down to `maxChunks`.
 */
export function chunkText(text: string, opts: Partial<ChunkOptions> = {}): Chunk[] {
  const o = { ...DEFAULT_CHUNKING, ...opts }
  const len = text.length
  // Long documents: take evenly spaced passages instead of chunking everything.
  if (len > o.maxChunks * o.target * 2) return sampled(text, o)
  const chunks: Chunk[] = []
  let pos = 0
  while (pos < len) {
    while (pos < len && /\s/.test(text[pos]!)) pos++
    if (pos >= len) break
    let end = Math.min(len, pos + o.target)
    if (end < len) end = findBreak(text, pos + Math.floor(o.target * 0.6), Math.min(len, pos + o.max))
    const piece = text.slice(pos, end)
    if (piece.replace(/\s+/g, "").length >= 16) chunks.push({ start: pos, end })
    if (end >= len) break
    let next = Math.max(pos + 1, end - o.overlap)
    // Start the overlap at a word boundary.
    const sp = text.indexOf(" ", next)
    if (sp > 0 && sp < end) next = sp + 1
    pos = next
  }
  if (chunks.length <= o.maxChunks) return chunks
  const out: Chunk[] = []
  const step = chunks.length / o.maxChunks
  for (let i = 0; i < o.maxChunks; i++) out.push(chunks[Math.floor(i * step)]!)
  return out
}

function sampled(text: string, o: ChunkOptions): Chunk[] {
  const out: Chunk[] = []
  const stride = text.length / o.maxChunks
  for (let i = 0; i < o.maxChunks; i++) {
    let start = Math.floor(i * stride)
    // Start at the next paragraph or word boundary.
    const para = text.indexOf("\n", start)
    if (para >= 0 && para - start < o.target / 3) start = para + 1
    else {
      const sp = text.indexOf(" ", start)
      if (sp >= 0 && sp - start < 64) start = sp + 1
    }
    while (start < text.length && /\s/.test(text[start]!)) start++
    if (start >= text.length) break
    let end = Math.min(text.length, start + o.target)
    if (end < text.length) end = findBreak(text, start + Math.floor(o.target * 0.6), Math.min(text.length, start + o.max))
    if (text.slice(start, end).replace(/\s+/g, "").length >= 16) out.push({ start, end })
  }
  return out
}
