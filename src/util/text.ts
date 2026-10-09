/** Text helpers shared by indexing and search. They mirror SQLite's unicode61 tokenizer (remove_diacritics 2). */

const NON_ASCII = /[^\x00-\x7f]/
const MARKS = /\p{M}+/gu

/** Lower-case and strip diacritics, the way unicode61 folds tokens. */
export function foldTerm(s: string): string {
  if (!NON_ASCII.test(s)) return s.toLowerCase()
  return s.normalize("NFD").replace(MARKS, "").toLowerCase()
}

const WORD = /[\p{L}\p{N}\p{Co}]+/gu
const ASCII_WORD = /[A-Za-z0-9]+/g

/** Unique folded word tokens of a text (for the vocabulary used by regex/fuzzy prefilters). */
export function uniqueTerms(text: string, into: Set<string> = new Set()): Set<string> {
  const re = NON_ASCII.test(text) ? WORD : ASCII_WORD
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const w = m[0]
    if (w.length > 64) continue
    into.add(re === ASCII_WORD ? w.toLowerCase() : foldTerm(w))
  }
  return into
}

/** ASCII characters other than letters and digits: separators for unicode61, so no token spans one. */
const ASCII_SEPARATORS = /[\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+/

/**
 * What the index keeps of a text: its distinct words for the FTS `body` column, and its
 * vocabulary terms (as `uniqueTerms`). The index is contentless with detail=column, so it
 * records which words a file holds but not where or how often: indexing each word once gives
 * the same matches for a fraction of SQLite's work.
 */
export function indexTerms(text: string): { body: string; terms: Iterable<string> } {
  if (!NON_ASCII.test(text)) {
    // ASCII: the tokens are exactly the runs of letters and digits, lower-cased.
    const words = new Set(text.toLowerCase().match(ASCII_WORD))
    const body = [...words].join(" ")
    for (const w of words) if (w.length > 64) words.delete(w)
    return { body, terms: words }
  }
  // Otherwise split only at ASCII separators, and leave the rest to SQLite's tokenizer.
  const body = [...new Set(text.split(ASCII_SEPARATORS))].join(" ")
  return { body, terms: uniqueTerms(body) }
}

/** The FTS `body` of a text (see `indexTerms`). */
export function ftsBody(text: string): string {
  return indexTerms(text).body
}

/** Split identifiers: "getHTTPResponse_v2" -> ["get", "HTTP", "Response", "v", "2"]. */
export function splitIdentifier(s: string): string[] {
  return s
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** Tokens for the FTS `name` column: words of the file name, including camelCase parts. */
export function nameTokens(name: string): string {
  const words = new Set<string>()
  for (const part of name.split(/[^\p{L}\p{N}]+/u)) {
    if (!part) continue
    words.add(part)
    const pieces = splitIdentifier(part)
    if (pieces.length > 1) for (const p of pieces) words.add(p)
  }
  return [...words].join(" ")
}

/** Tokens for the FTS `dirs` column: folder names leading to the file. */
export function dirTokens(dir: string, home: string): string {
  const rel = dir === home ? "" : dir.startsWith(home + "/") ? dir.slice(home.length + 1) : dir
  return rel.split("/").filter(Boolean).map(nameTokens).join(" ")
}

/** Quote a term for an FTS5 MATCH expression. */
export function ftsQuote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

/** Escape a string for use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
}

/** Smart case: case-sensitive only if the pattern contains an upper-case letter. */
export function smartCaseSensitive(s: string): boolean {
  return /\p{Lu}/u.test(s)
}

/** Damerau-Levenshtein (optimal string alignment) distance with an early-exit bound. */
export function editDistance(a: string, b: string, max: number): number {
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > max) return max + 1
  if (la === 0) return lb
  if (lb === 0) return la
  let prev2 = new Array<number>(lb + 1)
  let prev = new Array<number>(lb + 1)
  let cur = new Array<number>(lb + 1)
  for (let j = 0; j <= lb; j++) prev[j] = j
  for (let i = 1; i <= la; i++) {
    cur[0] = i
    let rowMin = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= lb; j++) {
      const cb = b.charCodeAt(j - 1)
      const cost = ca === cb ? 0 : 1
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) v = Math.min(v, prev2[j - 2]! + 1)
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    const t = prev2
    prev2 = prev
    prev = cur
    cur = t
  }
  return prev[lb]!
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US")
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function formatAge(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms)
  const min = 60_000
  if (d < min) return "just now"
  if (d < 60 * min) return `${Math.floor(d / min)}m ago`
  if (d < 24 * 60 * min) return `${Math.floor(d / (60 * min))}h ago`
  if (d < 30 * 24 * 60 * min) return `${Math.floor(d / (24 * 60 * min))}d ago`
  if (d < 365 * 24 * 60 * min) return `${Math.floor(d / (30 * 24 * 60 * min))}mo ago`
  return `${Math.floor(d / (365 * 24 * 60 * min))}y ago`
}

export function formatDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
