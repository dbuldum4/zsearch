import { resolve } from "node:path"
import { paths, tildify } from "../config.ts"
import { lockHolder } from "../index/lock.ts"
import { crawlOptionsFor, policyFor, under } from "../index/policy.ts"
import { escapeRegExp } from "../util/text.ts"
import { booleanQuery } from "./boolean.ts"
import type { SearchEngine, SearchResponse } from "./engine.ts"
import { hasFilters, type Mode, parseQuery, withoutFilters } from "./query.ts"

/**
 * Why a search found nothing, and what would find something. Each part is left out when it
 * does not apply. Counts come from searches capped at PROBE_LIMIT results: `more` when there are more.
 */
export interface SearchDiagnosis {
  /** Filters without which the query matches: `query` is the query without them. */
  filters?: { filter: FilterGroup | "all"; query: string; count: number; more: boolean }[]
  /** `in:` folders the index does not cover, skips, holds by name only, or that do not exist. */
  folders?: { path: string; reason: "outside" | "excluded" | "namesOnly" | "missing" }[]
  /** File contents are off in the settings: only names were searched. */
  contentsOff?: boolean
  /** Files the query's filters allow (all files, without filters) whose contents could not be read when indexed. */
  unreadable?: number
  /** An index update is running: results may be incomplete. */
  indexing?: boolean
  /** Semantic search matched words only: its index is not complete for the current files yet. */
  semanticPending?: boolean
  /** Other modes that find something for the same query. */
  modes?: { mode: Mode; count: number; more: boolean }[]
  /** The query with similar indexed words in place of unknown ones ("Did you mean"). */
  suggestion?: string
}

export type FilterGroup = (typeof FILTER_GROUPS)[number]["filter"]

/** Filters that narrow a search, by the keys written for them (see `parseQuery`). */
const FILTER_GROUPS = [
  { filter: "date", keys: ["mtime", "modified", "changed", "after", "since", "before"] },
  { filter: "created", keys: ["created"] },
  { filter: "size", keys: ["size"] },
  { filter: "type", keys: ["type", "kind", "is", "ext"] },
  { filter: "folder", keys: ["in", "dir"] },
  { filter: "path", keys: ["path"] },
  { filter: "name", keys: ["name"] },
  { filter: "tag", keys: ["tag"] },
] as const

/** All the explaining searches together stop starting after this long. */
const DIAGNOSIS_MS = 1000
const PROBE_LIMIT = 100

/**
 * Explain a response without hits: filters, folders and settings that leave files out, an index
 * still being built, and other modes or words that match. Undefined when there is nothing to say,
 * or when `cancelled` (a newer search superseded this one).
 */
export async function diagnose(engine: SearchEngine, res: SearchResponse, cancelled?: () => boolean): Promise<SearchDiagnosis | undefined> {
  if (cancelled?.()) return undefined
  const deadline = performance.now() + DIAGNOSIS_MS
  const q = parseQuery(res.query, Date.now(), res.mode)
  const text = !!(q.text || q.phrases.length)
  if (!text && !hasFilters(q.filters)) return undefined
  const config = engine.config
  const d: SearchDiagnosis = {}

  const opts = crawlOptionsFor(config)
  const check = policyFor(opts)
  const folders: NonNullable<SearchDiagnosis["folders"]> = []
  for (const dir of q.filters.inPaths) {
    // A folder holding indexed folders is covered by them.
    if (opts.roots.some((r) => under(r, dir))) continue
    const policy = check(dir)
    const reason = !opts.roots.some((r) => under(dir, r)) ? "outside"
      : policy.allowed ? (config.content.enabled && text && !policy.content ? "namesOnly" : null)
      : policy.reason === "file unavailable" ? "missing"
      : policy.reason?.includes("outside") ? "outside" : "excluded"
    if (reason) folders.push({ path: tildify(dir), reason })
  }
  if (folders.length) d.folders = folders
  if (text && !config.content.enabled) d.contentsOff = true
  if (text && config.content.enabled) {
    const cat = engine.catalog
    let unreadable = 0
    for (const [id] of engine.db.query("SELECT id FROM files WHERE content_state = 2 LIMIT 100000").values() as number[][]) {
      const i = cat.indexOf(id!)
      if (i !== undefined && !cat.isDir[i] && cat.passes(i, q.filters)) unreadable++
    }
    if (unreadable) d.unreadable = unreadable
  }
  if (indexRunning(engine)) d.indexing = true
  if (res.resolved === "semantic" && engine.semanticWaiting()) d.semanticPending = true
  // The words of a grouped query keep its parentheses ("(budgt"): no single query to suggest.
  const similar = res.resolved === "semantic" || booleanQuery(res.query) ? null : engine.similarWords(q)
  if (similar) {
    // Words are replaced where they are words: not inside filter values or quoted phrases.
    const skip = [...q.filterSpans, ...[...res.query.matchAll(/"[^"]*"?/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }))]
    const edits: { start: number; end: number; word: string }[] = []
    q.words.forEach((w, i) => {
      if (similar[i] === w) return
      for (const m of res.query.matchAll(new RegExp(`(^|\\s|:)${escapeRegExp(w)}(?=\\s|$)`, "g"))) {
        const start = m.index + m[1]!.length
        if (skip.some((s) => start >= s.start && start < s.end) || edits.some((e) => e.start === start)) continue
        edits.push({ start, end: start + w.length, word: similar[i]! })
        break
      }
    })
    let suggestion = res.query
    for (const e of edits.sort((a, b) => b.start - a.start)) suggestion = suggestion.slice(0, e.start) + e.word + suggestion.slice(e.end)
    if (suggestion !== res.query) d.suggestion = suggestion
  }

  const probe = async (query: string, mode: Mode): Promise<SearchResponse | null | undefined> => {
    if (cancelled?.()) return null
    // Without anything left to look for (an order alone included), a search lists recent files: no answer to this query.
    const rest = parseQuery(query, Date.now(), mode)
    if (!rest.text && !rest.phrases.length && !hasFilters({ ...rest.filters, sort: undefined })) return undefined
    const left = deadline - performance.now()
    if (left <= 0) return undefined
    // Not every search keeps to its budget (semantic search waits for the query model, which may
    // be starting): stop waiting at the deadline and leave it to finish unseen.
    let timer: ReturnType<typeof setTimeout> | undefined
    const r = await Promise.race([
      engine.search(query, mode, { limit: PROBE_LIMIT, budgetMs: left, cancelled, explain: false }).catch(() => undefined),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), left) }),
    ]).finally(() => clearTimeout(timer))
    if (cancelled?.()) return null
    return r && !r.error && r.hits.length ? r : undefined
  }
  const found = (r: SearchResponse) => ({ count: r.total, more: r.partial || r.hits.length >= PROBE_LIMIT })
  const groups = FILTER_GROUPS.filter((g) => q.filterSpans.some((s) => (g.keys as readonly string[]).includes(s.key)))
  const filters: NonNullable<SearchDiagnosis["filters"]> = []
  for (const g of groups) {
    const query = withoutFilters(res.query, g.keys, res.mode)
    const r = await probe(query, res.mode)
    if (r === null) return undefined
    if (r) filters.push({ filter: g.filter, query, ...found(r) })
  }
  if (!filters.length && groups.length > 1) {
    const query = withoutFilters(res.query, groups.flatMap((g) => g.keys), res.mode)
    const r = await probe(query, res.mode)
    if (r === null) return undefined
    if (r) filters.push({ filter: "all", query, ...found(r) })
  }
  if (filters.length) d.filters = filters
  // A query that picks its mode itself (`re:`, `/regex/`, `f:`) means it.
  if (text && !q.forcedMode) {
    const semantic = config.semantic.enabled && config.content.enabled
    const others: Mode[] = res.resolved === "find" ? ["fuzzy", "semantic"] : res.resolved === "fuzzy" ? ["semantic"] : ["find", "fuzzy"]
    const modes: NonNullable<SearchDiagnosis["modes"]> = []
    for (const mode of others) {
      if (mode === "semantic" && !semantic) continue
      const r = await probe(res.query, mode)
      if (r === null) return undefined
      if (r) modes.push({ mode, ...found(r) })
    }
    if (modes.length) d.modes = modes
  }
  return Object.keys(d).length ? d : undefined
}

/** Whether an index update holds the lock of the engine's index (only known for the default index). */
function indexRunning(engine: SearchEngine): boolean {
  const p = paths()
  if (!engine.db.filename || resolve(engine.db.filename) !== resolve(p.db)) return false
  return lockHolder(p.lock) !== null
}

const FILTER_LABEL: Record<FilterGroup | "all", string> = {
  date: "the date filter", created: "the created filter", size: "the size filter", type: "the type filter",
  folder: "the folder filter", path: "the path filter", name: "the name filter", tag: "the tag filter", all: "filters",
}
const MODE_LABEL: Record<Mode, string> = { find: "Find", fuzzy: "Fuzzy search", semantic: "Semantic search" }

const results = (n: number, more: boolean) => `${n.toLocaleString("en-US")}${more ? "+" : ""} ${n === 1 && !more ? "result" : "results"}`

/** The diagnosis in sentences, for the terminal and MCP ("Did you mean" is in the notice). */
export function explainDiagnosis(d: SearchDiagnosis | undefined): string[] {
  if (!d) return []
  const out: string[] = []
  for (const f of d.folders ?? []) {
    out.push(f.reason === "outside" ? `${f.path} is not in the indexed folders` : f.reason === "excluded" ? `${f.path} is excluded from the index` : f.reason === "missing" ? `${f.path} does not exist` : `Only file names are indexed in ${f.path}`)
  }
  for (const f of d.filters ?? []) out.push(`${results(f.count, f.more)} without ${FILTER_LABEL[f.filter]}: ${f.query}`)
  if (d.contentsOff) out.push("File contents are off in the settings: only names were searched")
  if (d.unreadable) out.push(`${d.unreadable.toLocaleString("en-US")} indexed ${d.unreadable === 1 ? "file" : "files"} could not be read, so ${d.unreadable === 1 ? "its" : "their"} text was not searched`)
  if (d.indexing) out.push("Indexing is still running: results may be incomplete")
  if (d.semanticPending) out.push("Semantic indexing has not finished: only words were matched")
  for (const m of d.modes ?? []) out.push(`${MODE_LABEL[m.mode]} finds ${results(m.count, m.more)}`)
  return out
}
