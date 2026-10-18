/**
 * Saved searches and recent-search history, shared by the terminal app, the command line and
 * the Mac app (through `zsearch serve`). A search is its query text and mode: filters and sorting
 * are part of the query (`type:pdf mtime:<30d sort:-size`), so restoring the text restores them.
 *
 * Both live in `searches.json` in the data folder, next to the index: they are the user's own
 * state rather than settings, and stay when the index is rebuilt or deleted. Every change holds
 * `searches.lock` while it reads the file again and writes it, so frontends changing it at the
 * same time keep each other's changes. What this version cannot use (a newer version's mode or
 * fields) is written back as it was.
 */
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, paths } from "./config.ts"
import { acquireLock } from "./index/lock.ts"
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
/** A change waits this long for another process's change to finish. */
const LOCK_WAIT_MS = 5000

export function searchesFile(): string {
  return join(paths().data, "searches.json")
}

const isMode = (m: unknown): m is Mode => MODES.includes(m as Mode)
const spaced = (name: string) => name.replace(/\s+/g, " ").trim()

function cleanName(name: unknown): string {
  const n = typeof name === "string" ? spaced(name) : ""
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

/**
 * Names match without regard to case, the same in every locale and in the Mac app
 * (`SavedSearches.sameName`): Unicode's full uppercase mapping, which has no locale or context
 * rules (so "I" is "i" but "İ" is not, and "ß" is "SS"), then canonical equivalence.
 */
const foldName = (name: string) => name.toUpperCase().normalize("NFD")
export const sameName = (a: string, b: string) => foldName(a) === foldName(b)
const byName = (a: SavedSearch, b: SavedSearch) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })

/** The saved search called `name`: that exact name, or else the same name in other case. */
export function findSaved(searches: Searches, name: string): SavedSearch | undefined {
  const n = spaced(name)
  return searches.saved.find((s) => s.name === n) ?? searches.saved.find((s) => sameName(s.name, n))
}

/** What the file holds that this version cannot use, to write back unchanged. */
interface Kept {
  /** Top-level fields besides `saved` and `recent`. */
  rest: Record<string, unknown>
  saved: unknown[]
  recent: unknown[]
  /** Fields of usable entries that this version does not know. */
  fields: WeakMap<object, Record<string, unknown>>
}

const keptName = (k: unknown): string | undefined => {
  const name = (k as { name?: unknown } | null)?.name
  return typeof name === "string" ? spaced(name) : undefined
}

function read(): { searches: Searches; kept: Kept } {
  const searches: Searches = { saved: [], recent: [] }
  const kept: Kept = { rest: {}, saved: [], recent: [], fields: new WeakMap() }
  const file = searchesFile()
  if (!existsSync(file)) return { searches, kept }
  const r = readStored(file)
  if (r instanceof Error) {
    process.emitWarning(`zsearch: ignoring unreadable ${file} (the next change keeps it as ${file}.damaged): ${r.message}`)
    return { searches, kept }
  }
  const { saved, recent, ...rest } = r
  kept.rest = rest
  for (const s of Array.isArray(saved) ? saved : []) {
    let entry: SavedSearch
    try {
      entry = { name: cleanName(s?.name), query: cleanQuery(s?.query), mode: checkMode(s?.mode) }
    } catch {
      kept.saved.push(s)
      continue
    }
    if (!entry.query) kept.saved.push(s)
    else if (!findSaved(searches, entry.name)) {
      const { name: _n, query: _q, mode: _m, ...more } = s as Record<string, unknown>
      if (Object.keys(more).length) kept.fields.set(entry, more)
      searches.saved.push(entry)
    }
  }
  for (const s of Array.isArray(recent) ? recent : []) {
    let entry: RecentSearch
    try {
      entry = { query: cleanQuery(s?.query), mode: checkMode(s?.mode), at: Number.isFinite(s?.at) ? Number(s.at) : 0 }
    } catch {
      if (kept.recent.length < RECENT_LIMIT) kept.recent.push(s)
      continue
    }
    if (entry.query && !searches.recent.some((e) => e.query === entry.query)) {
      const { query: _q, mode: _m, at: _a, ...more } = s as Record<string, unknown>
      if (Object.keys(more).length) kept.fields.set(entry, more)
      searches.recent.push(entry)
    }
  }
  searches.saved.sort(byName)
  searches.recent.sort((a, b) => b.at - a.at).splice(RECENT_LIMIT)
  return { searches, kept }
}

/** What is stored, leaving out entries it cannot use (an unreadable file reads as empty). */
export function loadSearches(): Searches {
  return read().searches
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

function store(searches: Searches, kept: Kept): Searches {
  const file = searchesFile()
  const dir = paths().data
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  // An unreadable file loads as empty, and any change (even history, written on its own when a
  // result opens) would replace it: keep it aside so the saved searches it holds can be recovered.
  if (existsSync(file) && readStored(file) instanceof Error) renameSync(file, `${file}.damaged`)
  const withKept = <T extends object>(e: T) => ({ ...e, ...kept.fields.get(e) })
  const data = {
    ...kept.rest,
    saved: [...searches.saved.map(withKept), ...kept.saved],
    recent: [...searches.recent.map(withKept), ...kept.recent],
  }
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  renameSync(tmp, file)
  return searches
}

/**
 * Read, change and write the file while no other process does. The lock is the kernel's (flock),
 * so one left by a process that died is free again: there is no stale lock to time out.
 */
function change(fn: (searches: Searches, kept: Kept) => Searches): Searches {
  const release = acquireLock(join(paths().data, "searches.lock"), LOCK_WAIT_MS)
  if (!release) throw new Error("saved searches are busy in another zsearch; try again")
  try {
    const { searches, kept } = read()
    return fn(searches, kept)
  } finally {
    release()
  }
}

/** Save the search under `name`, replacing the one already called that. */
export function saveSearch(name: string, query: string, mode: Mode): Searches {
  const entry = { name: cleanName(name), query: cleanQuery(query), mode: checkMode(mode) }
  if (!entry.query) throw new Error("there is no search to save")
  return change((s, kept) => {
    const old = findSaved(s, entry.name)
    if (!old && s.saved.length >= SAVED_LIMIT) throw new Error(`there are already ${SAVED_LIMIT} saved searches`)
    s.saved = [...s.saved.filter((e) => e !== old), entry].sort(byName)
    // Saving over a name replaces the search called that, even one this version cannot show.
    kept.saved = kept.saved.filter((k) => {
      const n = keptName(k)
      return n === undefined || !sameName(n, entry.name)
    })
    return store(s, kept)
  })
}

export function renameSearch(name: string, to: string): Searches {
  const next = cleanName(to)
  return change((s, kept) => {
    const entry = findSaved(s, name)
    if (!entry) throw new Error(`no saved search is called "${name}"`)
    const taken = findSaved(s, next)
    if (taken && taken !== entry) throw new Error(`a saved search is already called "${taken.name}"`)
    const hidden = kept.saved.map(keptName).find((k) => k !== undefined && sameName(k, next))
    if (hidden) throw new Error(`a saved search from a newer version of zsearch is already called "${hidden}"`)
    entry.name = next
    s.saved.sort(byName)
    return store(s, kept)
  })
}

export function deleteSearch(name: string): Searches {
  return change((s, kept) => {
    const entry = findSaved(s, name)
    if (!entry) throw new Error(`no saved search is called "${name}"`)
    s.saved = s.saved.filter((e) => e !== entry)
    return store(s, kept)
  })
}

/**
 * Remember a search the user committed to (opened a result from), as the newest. The same query
 * run again moves to the top with its latest mode; an empty query is not a search to remember,
 * and nothing is remembered while the `searchHistory` setting is off.
 */
export function rememberSearch(query: string, mode: Mode, at = Date.now()): Searches {
  const q = cleanQuery(query)
  const m = checkMode(mode)
  if (!q || !loadConfig().searchHistory) return loadSearches()
  return change((s, kept) => {
    // Opening several results of one search writes once.
    if (s.recent[0]?.query === q && s.recent[0].mode === m) return s
    s.recent = [{ query: q, mode: m, at }, ...s.recent.filter((e) => e.query !== q)].slice(0, RECENT_LIMIT)
    return store(s, kept)
  })
}

/** Forget the history, including entries this version cannot use. */
export function clearRecent(): Searches {
  return change((s, kept) => {
    if (!s.recent.length && !kept.recent.length) return s
    s.recent = []
    kept.recent = []
    return store(s, kept)
  })
}
