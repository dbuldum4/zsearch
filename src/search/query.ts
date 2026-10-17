import { escapeRegExp } from "../util/text.ts"
import { resolvePath } from "../config.ts"
import { isKnownExt, KIND_ALIASES, type Kind } from "../kinds.ts"

/**
 * `find`: exact text, or a regex written as `/pattern/` or `re:pattern`. `fuzzy`: fzf-style.
 * `semantic`: by meaning, with an embedding model (src/semantic), when it is installed.
 */
export type Mode = "find" | "fuzzy" | "semantic"
export const MODES: Mode[] = ["find", "fuzzy", "semantic"]

export interface Filters {
  /** Only these file ids: set by the engine for a part of a grouped query, never by query text. */
  ids?: Set<number>
  not?: Filters[]
  createdMin?: number
  createdMax?: number
  tags?: string[]
  names?: { source: string; flags: string }[]
  sort?: string
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
  /** Mode forced by syntax (`re:`, `/.../`, `f:`...), else null. */
  forcedMode: Mode | null
  /** `text` is a regular expression (`/.../`, `re:`). */
  regex: boolean
  regexFlags: string
  all: boolean
  fold: boolean
  wholeWord: boolean
  caseMode?: boolean
  diacritics?: boolean
  near?: number
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

function emptyFilters(): Filters {
  return { exts: null, kinds: null, notKinds: null, inPaths: [], pathContains: [] }
}

export function hasFilters(f: Filters): boolean {
  return !!(f.ids || f.createdMin !== undefined || f.createdMax !== undefined || f.tags?.length || f.sort || f.names?.length || f.not?.length || f.exts || f.kinds || f.notKinds || f.inPaths.length || f.pathContains.length || f.sizeMin !== undefined || f.sizeMax !== undefined || f.mtimeMin !== undefined || f.mtimeMax !== undefined)
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

const FILTER_KEYS = new Set(["created", "tag", "name", "sort", "case", "word", "diacritics", "near", "fold", "ext", "type", "kind", "in", "dir", "path", "size", "mtime", "modified", "changed", "after", "before", "since", "limit", "is"])
const MODE_PREFIXES: Record<string, { mode: Mode; regex: boolean }> = {
  "re:": { mode: "find", regex: true },
  "regex:": { mode: "find", regex: true },
  "find:": { mode: "find", regex: false },
  "exact:": { mode: "find", regex: false },
  "grep:": { mode: "find", regex: false },
  "fuzzy:": { mode: "fuzzy", regex: false },
  "f:": { mode: "fuzzy", regex: false },
  "semantic:": { mode: "semantic", regex: false },
  "meaning:": { mode: "semantic", regex: false },
  "s:": { mode: "semantic", regex: false },
}

interface Token {
  text: string
  start: number
  end: number
  quoted: boolean
}

/** Words, `"quoted phrases"`, and filters whose value is quoted (`in:"~/My Folder"`, read as one token). */
function tokenize(s: string): Token[] {
  const out: Token[] = []
  const re = new RegExp(`(-?(?:${[...FILTER_KEYS].join("|")}):)"([^"]*)"?|"([^"]*)"?|\\S+`, "gi")
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const text = m[1] !== undefined ? m[1] + m[2] : m[3] !== undefined ? m[3] : m[0]
    out.push({ text, start: m.index, end: m.index + m[0].length, quoted: m[3] !== undefined })
  }
  return out
}

/** `mode`: the mode the query runs in unless its text forces another (a semantic query's `word?` is a word, not a glob). */
export function parseQuery(raw: string, now = Date.now(), mode?: Mode): ParsedQuery {
  const filters = emptyFilters()
  const warnings: string[] = []
  let forcedMode: Mode | null = null
  let regex = false
  let regexFlags = ""
  let all = false
  let fold = false
  let wholeWord = false
  let caseMode: boolean | undefined
  let diacritics: boolean | undefined
  let near: number | undefined
  let s = raw
  if (/^\s*all:/i.test(raw)) { all = true; s = raw.replace(/^\s*all:/i, ""); forcedMode = "find" }
  const lead = s.trimStart()
  for (const [prefix, m] of Object.entries(MODE_PREFIXES)) {
    if (lead.toLowerCase().startsWith(prefix)) {
      forcedMode = m.mode
      regex = m.regex
      s = lead.slice(prefix.length)
      break
    }
  }
  if (/^\/[\s\S]*\/[dgimsuvy]*(?:\s|$)/.test(lead)) { forcedMode = "find"; regex = true }
  // Remove filter tokens, keep the rest of the text verbatim (regexes care about spacing).
  const tokens = tokenize(s)
  const cut: [number, number][] = []
  const semantic = (forcedMode ?? mode) === "semantic"
  for (const t of tokens) {
    if (t.quoted) continue
    const proximity = !regex && forcedMode !== "fuzzy" && !semantic ? /^NEAR\/(\d+)$/.exec(t.text) : null
    if (proximity) {
      const distance = Number(proximity[1])
      if (distance > 1000) warnings.push("NEAR expects a word distance from 0 to 1000")
      else { near = distance; all = true; forcedMode = "find" }
      cut.push([t.start, t.end]); continue
    }
    if (!regex && forcedMode !== "fuzzy" && !semantic && /[?*]/.test(t.text) && !t.text.includes("/") && !t.text.includes(":")) {
      ;(filters.names ??= []).push({ source: globPattern(t.text), flags: "i" }); cut.push([t.start, t.end]); continue
    }
    const m = /^(-?)([a-z]+):(.*)$/i.exec(t.text)
    if (!m || !FILTER_KEYS.has(m[2]!.toLowerCase())) continue
    const neg = m[1] === "-"
    const key = m[2]!.toLowerCase()
    const value = m[3]!
    if (!value) continue
    if (["case", "word", "diacritics", "fold"].includes(key)) {
      if (!/^(true|false|on|off)$/i.test(value)) warnings.push(`${key} expects on or off`)
      else { const enabled = /^(true|on)$/i.test(value) !== neg; if (key === "case") caseMode = enabled; else if (key === "word") wholeWord = enabled; else if (key === "fold") fold = enabled; else diacritics = enabled }
      cut.push([t.start, t.end]); continue
    }
    if (key === "near") {
      const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 1000) warnings.push("near expects a word distance from 0 to 1000"); else { near = n; all = true }
      cut.push([t.start, t.end]); continue
    }
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
  text = text.replace(/\s{2,}/g, (w) => (regex ? w : " ")).trim()

  // Only regex flag letters count as flags, so an absolute path such as /etc/hosts stays text.
  const delimited = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(text)
  if (delimited && (!forcedMode || regex)) {
    forcedMode = "find"; regex = true; text = delimited[1]!; regexFlags = delimited[2]!
  }
  const words: string[] = []
  const phrases: string[] = []
  const negated: string[] = []
  if (!regex) {
    const all = tokenize(text)
    for (const t of all) {
      if (t.quoted) {
        if (t.text.trim()) phrases.push(t.text)
      } else if (t.text.length > 1 && (t.text[0] === "!" || (t.text[0] === "-" && /^-[\p{L}\p{N}]/u.test(t.text)))) {
        negated.push(t.text.slice(1))
      } else words.push(t.text)
    }
  }
  return { raw, text, filters, forcedMode, regex, regexFlags, all, fold, wholeWord, caseMode, diacritics, near, words, phrases, negated, typing, warnings }
}

function applyFilter(f: Filters, key: string, value: string, neg: boolean, now: number, warnings: string[]): boolean {
  if (neg && !["type", "kind", "is"].includes(key)) {
    if (["limit", "sort"].includes(key)) { warnings.push(`${key} cannot be negated`); return true }
    const inverse = emptyFilters()
    if (!applyFilter(inverse, key, value, false, now, warnings)) return false
    ;(f.not ??= []).push(inverse)
    return true
  }
  switch (key) {
    case "created": {
      const temporary = emptyFilters(); if (!applyFilter(temporary, "mtime", value, false, now, warnings)) return false
      f.createdMin = temporary.mtimeMin; f.createdMax = temporary.mtimeMax; return true
    }
    case "tag":
      ;(f.tags ??= []).push(value); return true
    case "name": {
      const regex = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(value)
      const source = regex ? regex[1]! : /[?*]/.test(value) ? globPattern(value) : escapeRegExp(value)
      const flags = regex ? regex[2]! : "i"
      try { new RegExp(source, flags) } catch { warnings.push(`invalid name regex: ${value}`); return true }
      ;(f.names ??= []).push({ source, flags }); return true
    }
    case "sort":
      if (!/^-?(name|size|date|path)$/.test(value)) { warnings.push("sort expects name, size, date, path, optionally prefixed with -"); return true }
      f.sort = value; return true
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
        else if (key !== "is") {
          const ext = v.replace(/^\*?\./, "")
          warnings.push(`unknown type "${v}"` + (isKnownExt(ext) ? `, did you mean ${neg ? "-" : ""}ext:${ext}?` : ""))
        }
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
        // An age compares the other way round from a date: mtime:<7d is newer than 7 days ago and
        // mtime:>1y older than a year ago, while after:7d / since:7d and before:7d name the moment.
        const older = key === "after" || key === "since" ? false : key === "before" ? true : op === ">" || op === ">="
        if (older) f.mtimeMax = now - dur
        else f.mtimeMin = now - dur
        return true
      }
      const when = parseWhen(v, now)
      if (!when) break
      if (op === ">" || op === ">=") f.mtimeMin = when[0]
      else if (op === "<=") { if (when[1] !== Infinity) f.mtimeMax = when[1] }
      else if (op === "<") f.mtimeMax = when[0]
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


function globPattern(glob: string): string {
  return "^" + [...glob].map((c) => c === "*" ? ".*" : c === "?" ? "." : escapeRegExp(c)).join("") + "$"
}
