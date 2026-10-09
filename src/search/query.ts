import { home, resolvePath } from "../config.ts"
import { KIND_ALIASES, type Kind } from "../kinds.ts"

export type Mode = "auto" | "fuzzy" | "exact" | "regex"
export const MODES: Mode[] = ["auto", "fuzzy", "exact", "regex"]

export interface Filters {
  exts: Set<string> | null
  kinds: Set<Kind> | null
  notKinds: Set<Kind> | null
  /** Absolute folder prefixes. */
  inPaths: string[]
  /** Lower-case substrings of the path. */
  pathContains: string[]
  sizeMin?: number
  sizeMax?: number
  mtimeMin?: number
  mtimeMax?: number
  limit?: number
}

export interface ParsedQuery {
  raw: string
  /** Query text with filters and mode prefixes removed. */
  text: string
  filters: Filters
  /** Mode forced by syntax (`re:`, `/.../`, `?`, quotes...), else null. */
  forcedMode: Mode | null
  /** Free-text words (unquoted, not negated). */
  words: string[]
  /** Quoted phrases. */
  phrases: string[]
  /** Words prefixed with `!` or `-`. */
  negated: string[]
  /** Whether the user is still typing the last word (no trailing space). */
  typing: boolean
  /** Errors in filters (shown in the status bar). */
  warnings: string[]
}

export function emptyFilters(): Filters {
  return { exts: null, kinds: null, notKinds: null, inPaths: [], pathContains: [] }
}

export function hasFilters(f: Filters): boolean {
  return !!(f.exts || f.kinds || f.notKinds || f.inPaths.length || f.pathContains.length || f.sizeMin !== undefined || f.sizeMax !== undefined || f.mtimeMin !== undefined || f.mtimeMax !== undefined)
}

const SIZE_UNITS: Record<string, number> = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 }

export function parseSize(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?b?)?$/i.exec(s.trim())
  if (!m) return null
  return Math.round(Number(m[1]) * (SIZE_UNITS[(m[2] || "b").toLowerCase()] ?? 1))
}

const DUR_UNITS: Record<string, number> = { s: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, mo: 30 * 86_400_000, y: 365 * 86_400_000 }

export function parseDuration(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(s|min|m|h|d|w|mo|y)$/i.exec(s.trim())
  if (!m) return null
  return Number(m[1]) * DUR_UNITS[m[2]!.toLowerCase()]!
}

function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Parse a date or relative age into an absolute [from, to) range. */
function parseWhen(v: string, now: number): [number, number] | null {
  const lower = v.toLowerCase()
  if (lower === "today") return [startOfDay(now), Infinity]
  if (lower === "yesterday") return [startOfDay(now) - 86_400_000, startOfDay(now)]
  if (lower === "week") return [now - 7 * 86_400_000, Infinity]
  if (lower === "month") return [now - 30 * 86_400_000, Infinity]
  if (lower === "year") return [now - 365 * 86_400_000, Infinity]
  if (/^\d{4}$/.test(v)) return [new Date(Number(v), 0, 1).getTime(), new Date(Number(v) + 1, 0, 1).getTime()]
  if (/^\d{4}-\d{2}$/.test(v)) {
    const [y, mo] = v.split("-").map(Number) as [number, number]
    return [new Date(y, mo - 1, 1).getTime(), new Date(y, mo, 1).getTime()]
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = new Date(`${v}T00:00:00`).getTime()
    return Number.isFinite(t) ? [t, t + 86_400_000] : null
  }
  return null
}

const FILTER_KEYS = new Set(["ext", "type", "kind", "in", "dir", "path", "size", "mtime", "modified", "changed", "after", "before", "since", "limit", "is"])
const MODE_PREFIXES: Record<string, Mode> = {
  "re:": "regex",
  "regex:": "regex",
  "grep:": "exact",
  "exact:": "exact",
  "fuzzy:": "fuzzy",
  "f:": "fuzzy",
}

interface Token {
  text: string
  start: number
  end: number
  quoted: boolean
}

function tokenize(s: string): Token[] {
  const out: Token[] = []
  const re = /"([^"]*)"?|\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    out.push({ text: m[1] !== undefined ? m[1] : m[0], start: m.index, end: m.index + m[0].length, quoted: m[1] !== undefined })
  }
  return out
}

export function parseQuery(raw: string, now = Date.now()): ParsedQuery {
  const filters = emptyFilters()
  const warnings: string[] = []
  let forcedMode: Mode | null = null
  let s = raw
  const lead = s.trimStart()
  for (const [prefix, mode] of Object.entries(MODE_PREFIXES)) {
    if (lead.toLowerCase().startsWith(prefix)) {
      forcedMode = mode
      s = lead.slice(prefix.length)
      break
    }
  }
  // Remove filter tokens, keep the rest of the text verbatim (regexes care about spacing).
  const tokens = tokenize(s)
  const cut: [number, number][] = []
  for (const t of tokens) {
    if (t.quoted) continue
    const m = /^(-?)([a-z]+):(.*)$/i.exec(t.text)
    if (!m || !FILTER_KEYS.has(m[2]!.toLowerCase())) continue
    const neg = m[1] === "-"
    const key = m[2]!.toLowerCase()
    const value = m[3]!
    if (!value) continue
    if (applyFilter(filters, key, value, neg, now, warnings)) cut.push([t.start, t.end])
  }
  let text = ""
  let pos = 0
  for (const [a, b] of cut) {
    text += s.slice(pos, a)
    pos = b
  }
  text += s.slice(pos)
  const typing = !/\s$/.test(raw)
  text = text.replace(/\s{2,}/g, (w) => (forcedMode === "regex" ? w : " ")).trim()

  // `/pattern/` is a regex.
  if (!forcedMode && /^\/.+\/[imsux]*$/.test(text) && text.length > 2) {
    forcedMode = "regex"
    text = text.replace(/^\/(.*)\/[imsux]*$/, "$1")
  }
  const words: string[] = []
  const phrases: string[] = []
  const negated: string[] = []
  if (forcedMode !== "regex") {
    const all = tokenize(text)
    if (!forcedMode && all.length === 1 && all[0]!.quoted && text.startsWith('"')) forcedMode = "exact"
    for (const t of all) {
      if (t.quoted) {
        if (t.text.trim()) phrases.push(t.text)
      } else if (t.text.length > 1 && (t.text[0] === "!" || (t.text[0] === "-" && /^-[\p{L}\p{N}]/u.test(t.text)))) {
        negated.push(t.text.slice(1))
      } else words.push(t.text)
    }
  }
  return { raw, text, filters, forcedMode, words, phrases, negated, typing, warnings }
}

function applyFilter(f: Filters, key: string, value: string, neg: boolean, now: number, warnings: string[]): boolean {
  switch (key) {
    case "ext": {
      const exts = value
        .split(",")
        .map((e) => e.trim().replace(/^\*?\./, "").toLowerCase())
        .filter(Boolean)
      f.exts = new Set([...(f.exts ?? []), ...exts])
      return true
    }
    case "type":
    case "kind":
    case "is": {
      const kinds: Kind[] = []
      for (const v of value.toLowerCase().split(",")) {
        const k = KIND_ALIASES[v]
        if (k) kinds.push(...k)
        else if (key !== "is") warnings.push(`unknown type "${v}"`)
      }
      if (!kinds.length) return key !== "is" // `is:` with unknown value stays as text
      if (neg) f.notKinds = new Set([...(f.notKinds ?? []), ...kinds])
      else f.kinds = new Set([...(f.kinds ?? []), ...kinds])
      return true
    }
    case "in":
    case "dir": {
      let p = value
      if (!p.startsWith("/") && !p.startsWith("~")) p = `~/${p}`
      f.inPaths.push(resolvePath(p).replace(/\/+$/, "") || "/")
      return true
    }
    case "path":
      f.pathContains.push(value.toLowerCase())
      return true
    case "size": {
      const range = /^(.+?)\.\.(.+)$/.exec(value)
      if (range) {
        const a = parseSize(range[1]!)
        const b = parseSize(range[2]!)
        if (a === null || b === null) break
        f.sizeMin = a
        f.sizeMax = b
        return true
      }
      const m = /^(>=|<=|>|<|=)?(.+)$/.exec(value)!
      const n = parseSize(m[2]!)
      if (n === null) break
      const op = m[1] ?? ">"
      if (op === ">" || op === ">=") f.sizeMin = n
      else if (op === "<" || op === "<=") f.sizeMax = n
      else {
        f.sizeMin = Math.floor(n * 0.9)
        f.sizeMax = Math.ceil(n * 1.1)
      }
      return true
    }
    case "mtime":
    case "modified":
    case "changed":
    case "since":
    case "after":
    case "before": {
      const m = /^(>=|<=|>|<|=)?(.+)$/.exec(value)!
      let op = m[1] ?? ""
      const v = m[2]!
      if (key === "after" || key === "since") op = ">"
      if (key === "before") op = "<"
      const dur = parseDuration(v)
      if (dur !== null) {
        // mtime:<7d = changed within the last 7 days; mtime:>1y = older than a year
        if (op === ">" || op === ">=") f.mtimeMax = now - dur
        else f.mtimeMin = now - dur
        return true
      }
      const when = parseWhen(v, now)
      if (!when) break
      if (op === ">" || op === ">=") f.mtimeMin = when[0]
      else if (op === "<" || op === "<=") f.mtimeMax = op === "<=" && when[1] !== Infinity ? when[1] : when[0]
      else {
        f.mtimeMin = when[0]
        if (when[1] !== Infinity) f.mtimeMax = when[1]
      }
      return true
    }
    case "limit": {
      const n = Number(value)
      if (!Number.isInteger(n) || n <= 0) break
      f.limit = Math.min(n, 5000)
      return true
    }
  }
  warnings.push(`could not understand ${key}:${value}`)
  return false
}

/** Human readable summary of the active filters, for the status line. */
export function describeFilters(f: Filters): string {
  const parts: string[] = []
  if (f.kinds) parts.push(`type:${[...f.kinds].join(",")}`)
  if (f.notKinds) parts.push(`-type:${[...f.notKinds].join(",")}`)
  if (f.exts) parts.push(`ext:${[...f.exts].join(",")}`)
  const h = home()
  for (const p of f.inPaths) parts.push(`in:${p.startsWith(h) ? "~" + p.slice(h.length) : p}`)
  for (const p of f.pathContains) parts.push(`path:${p}`)
  if (f.sizeMin !== undefined) parts.push(`size>${f.sizeMin}`)
  if (f.sizeMax !== undefined) parts.push(`size<${f.sizeMax}`)
  if (f.mtimeMin !== undefined) parts.push(`after ${new Date(f.mtimeMin).toISOString().slice(0, 10)}`)
  if (f.mtimeMax !== undefined) parts.push(`before ${new Date(f.mtimeMax).toISOString().slice(0, 10)}`)
  return parts.join(" ")
}
