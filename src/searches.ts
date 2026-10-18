/**
 * Saved searches and recent-search history, shared by the terminal app, the command line and
 * the Mac app (through `zsearch serve`). A search is its query text and mode: filters and sorting
 * are part of the query (`type:pdf mtime:<30d sort:-size`), so restoring the text restores them.
 *
 * Both live in `searches.json` in the data folder, next to the index: they are the user's own
 * state rather than settings, and stay when the index is rebuilt or deleted. Every change reads
 * the file again first, so several frontends writing in turn keep each other's changes.
 */
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { paths } from "./config.ts"
import { MODES, type Mode } from "./search/query.ts"

export interface SavedSearch {
  name: string
  query: string
  mode: Mode
}

export interface RecentSearch {
  query: string
  mode: Mode
  /** Milliseconds since 1970. */
  at: number
}

export interface Searches {
  /** By name. */
  saved: SavedSearch[]
  /** Newest first, one per query. */
  recent: RecentSearch[]
}

export const RECENT_LIMIT = 50
export const SAVED_LIMIT = 500
const NAME_MAX = 100
const QUERY_MAX = 2000

export function searchesFile(): string {
  return join(paths().data, "searches.json")
}

const isMode = (m: unknown): m is Mode => MODES.includes(m as Mode)

function cleanName(name: unknown): string {
  const n = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : ""
  if (!n) throw new Error("a saved search needs a name")
  if (n.length > NAME_MAX) throw new Error(`a saved search's name must be at most ${NAME_MAX} characters`)
  return n
}

function cleanQuery(query: unknown): string {
  const q = typeof query === "string" ? query.trim() : ""
  if (q.length > QUERY_MAX) throw new Error(`a search must be at most ${QUERY_MAX} characters`)
  return q
}

function checkMode(mode: unknown): Mode {
  if (!isMode(mode)) throw new Error(`unknown mode "${String(mode)}" (use ${MODES.join(", ")})`)
  return mode
}

const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0
const byName = (a: SavedSearch, b: SavedSearch) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })

/** The saved search called `name`: that exact name, or else the same name in other case. */
export function findSaved(searches: Searches, name: string): SavedSearch | undefined {
  const n = name.replace(/\s+/g, " ").trim()
  return searches.saved.find((s) => s.name === n) ?? searches.saved.find((s) => sameName(s.name, n))
}

/** What is stored, leaving out entries it cannot use (an unreadable file reads as empty). */
export function loadSearches(): Searches {
  const out: Searches = { saved: [], recent: [] }
  const file = searchesFile()
  if (!existsSync(file)) return out
  const r = readStored(file)
  if (r instanceof Error) {
    process.emitWarning(`zsearch: ignoring unreadable ${file} (the next change keeps it as ${file}.damaged): ${r.message}`)
    return out
  }
  for (const s of Array.isArray(r.saved) ? r.saved : []) {
    try {
      const entry = { name: cleanName(s?.name), query: cleanQuery(s?.query), mode: checkMode(s?.mode) }
      if (entry.query && !findSaved(out, entry.name)) out.saved.push(entry)
    } catch { /* skipped */ }
  }
  for (const s of Array.isArray(r.recent) ? r.recent : []) {
    try {
      const entry = { query: cleanQuery(s?.query), mode: checkMode(s?.mode), at: Number.isFinite(s?.at) ? Number(s.at) : 0 }
      if (entry.query && !out.recent.some((e) => e.query === entry.query)) out.recent.push(entry)
    } catch { /* skipped */ }
  }
  out.saved.sort(byName)
  out.recent.sort((a, b) => b.at - a.at).splice(RECENT_LIMIT)
  return out
}

/** The file's contents, or why they cannot be used. */
function readStored(file: string): { saved?: unknown; recent?: unknown } | Error {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"))
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : new Error("not a JSON object")
  } catch (err) {
    return err as Error
  }
}

function store(searches: Searches): Searches {
  const file = searchesFile()
  const dir = paths().data
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  // An unreadable file loads as empty, and any change (even history, written on its own when a
  // result opens) would replace it: keep it aside so the saved searches it holds can be recovered.
  if (existsSync(file) && readStored(file) instanceof Error) renameSync(file, `${file}.damaged`)
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(searches, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  renameSync(tmp, file)
  return searches
}

/** Save the search under `name`, replacing the one already called that. */
export function saveSearch(name: string, query: string, mode: Mode): Searches {
  const entry = { name: cleanName(name), query: cleanQuery(query), mode: checkMode(mode) }
  if (!entry.query) throw new Error("there is no search to save")
  const s = loadSearches()
  const old = findSaved(s, entry.name)
  if (!old && s.saved.length >= SAVED_LIMIT) throw new Error(`there are already ${SAVED_LIMIT} saved searches`)
  s.saved = [...s.saved.filter((e) => e !== old), entry].sort(byName)
  return store(s)
}

export function renameSearch(name: string, to: string): Searches {
  const next = cleanName(to)
  const s = loadSearches()
  const entry = findSaved(s, name)
  if (!entry) throw new Error(`no saved search is called "${name}"`)
  const taken = findSaved(s, next)
  if (taken && taken !== entry) throw new Error(`a saved search is already called "${taken.name}"`)
  entry.name = next
  s.saved.sort(byName)
  return store(s)
}

export function deleteSearch(name: string): Searches {
  const s = loadSearches()
  const entry = findSaved(s, name)
  if (!entry) throw new Error(`no saved search is called "${name}"`)
  s.saved = s.saved.filter((e) => e !== entry)
  return store(s)
}

/**
 * Remember a search the user committed to (opened a result from), as the newest. The same query
 * run again moves to the top with its latest mode; an empty query is not a search to remember.
 */
export function rememberSearch(query: string, mode: Mode, at = Date.now()): Searches {
  const q = cleanQuery(query)
  const m = checkMode(mode)
  const s = loadSearches()
  if (!q) return s
  // Opening several results of one search writes once.
  if (s.recent[0]?.query === q && s.recent[0].mode === m) return s
  s.recent = [{ query: q, mode: m, at }, ...s.recent.filter((e) => e.query !== q)].slice(0, RECENT_LIMIT)
  return store(s)
}

export function clearRecent(): Searches {
  const s = loadSearches()
  if (!s.recent.length) return s
  s.recent = []
  return store(s)
}
