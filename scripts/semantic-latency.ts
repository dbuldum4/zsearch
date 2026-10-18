#!/usr/bin/env bun
/**
 * How long semantic searches take on a real index, with the real Granite helper.
 *
 *   bun scripts/semantic-latency.ts --index=DIR [--runs=5] [--cold=3] [--json=out.json] [--compare=before.json]
 *
 * DIR holds a copy of an index (`index.db` and `index.semantic.db`), so that every run sees the same
 * files and vectors and nothing else writes to them while it runs:
 *
 *   sqlite3 ~/Library/Application\ Support/zsearch/index.db ".backup DIR/index.db"
 *   sqlite3 ~/Library/Application\ Support/zsearch/index.semantic.db ".backup DIR/index.semantic.db"
 *
 * Measured in-process, through `SearchEngine.search` as the search worker runs it:
 *
 *   cold     the first semantic search of a new engine: helper and model start, vectors load
 *   search   a whole query, typed and searched once typing stops (the typical search): the
 *            engine is warm, the query's vector is not cached
 *   typing   each prefix of each query, as searches while typing
 *
 * `--json` saves the timings and each query's top results (file ids only); `--compare` checks
 * the results against a saved run and prints the speedup.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../src/config.ts"
import { openDb } from "../src/index/db.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { embedToolPath } from "../src/semantic/helper.ts"
import { GRANITE, installedModel } from "../src/semantic/model.ts"

const args = new Map(process.argv.slice(2).map((a) => { const i = a.indexOf("="); return i < 0 ? [a.replace(/^--/, ""), "true"] as const : [a.slice(2, i), a.slice(i + 1)] as const }))
const dir = (args.get("index") ?? "").replace(/^~/, process.env.HOME ?? "~")
if (!dir) throw new Error("--index=DIR is required")
const runs = Number(args.get("runs") ?? 5)
const coldRuns = Number(args.get("cold") ?? 3)
if (!embedToolPath() || !installedModel(GRANITE)) throw new Error("needs zsearch-embed (scripts/build-embed.sh) and the Granite model (zsearch semantic install)")

/** Typical searches: a word or two, names of things, and questions. */
export const QUERIES = [
  "invoice",
  "resume",
  "tax return 2023",
  "lease agreement",
  "flight confirmation",
  "meeting notes about the budget",
  "photos of the apartment lease",
  "how to install the software",
  "machine learning paper",
  "letter of recommendation",
  "bank statement from last month",
  "chemistry lab report",
]
const TOP = 20

const dbPath = join(dir, "index.db")
const config = loadConfig()
config.semantic.enabled = true
config.content.enabled = true

const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]! }
const stats = (xs: number[]) => ({ median: quantile(xs, 0.5), p90: quantile(xs, 0.9), min: Math.min(...xs), max: Math.max(...xs), n: xs.length })
const f = (x: number) => x.toFixed(1).padStart(8)

/** A new engine on the index copy, whose queries are never answered from a cache of query vectors. */
function newEngine(): SearchEngine {
  const engine = new SearchEngine(openDb(dbPath, { readonly: true }), config)
  return engine
}

function forgetQueryVectors(engine: SearchEngine) {
  // Typing a new query: its vector is made, not remembered.
  ;(engine as unknown as { queryEmbedder: { cache: Map<string, unknown> } | null }).queryEmbedder?.cache.clear()
}

async function search(engine: SearchEngine, q: string) {
  forgetQueryVectors(engine)
  const t = performance.now()
  const r = await engine.search(q, "semantic", { limit: 100 })
  const ms = performance.now() - t
  if (r.error) throw new Error(`${q}: ${r.error}`)
  if (!/^(semantic \+ words|words)( · |$)/.test(r.strategy)) throw new Error(`${q}: ${r.strategy}`)
  if (r.notice && /Granite|Semantic search/.test(r.notice)) throw new Error(`${q}: ${r.notice}`)
  return { ms, r }
}

// The first search of a new engine.
const cold: number[] = []
for (let k = 0; k < coldRuns; k++) {
  const engine = newEngine()
  const { ms } = await search(engine, QUERIES[k % QUERIES.length]!)
  cold.push(ms)
  engine.closeSemantic()
  engine.db.close()
}

// A warm engine, as the app's search worker is after its idle time.
const engine = newEngine()
while (engine.warmTexts(1000)) {}
for (const q of QUERIES) await search(engine, q)

const perQuery: Record<string, number[]> = {}
type Result = { total: number; top: number[]; strategy: string; hits: string; scores: number[] }
const results: Record<string, Result> = {}
/** What a search returned, without the files' names or text: ids, and a hash of their lines. */
const summary = (r: Awaited<ReturnType<SearchEngine["search"]>>): Result => ({
  total: r.total,
  top: r.hits.slice(0, TOP).map((h) => h.id),
  strategy: r.strategy,
  hits: Bun.hash(JSON.stringify(r.hits.map((h) => [h.id, h.sources, h.matchCount, h.lines.map((l) => [l.line, l.page, l.text, l.ranges])]))).toString(16),
  scores: r.hits.map((h) => h.score),
})
const all: number[] = []
for (let k = 0; k < runs; k++) {
  for (const q of QUERIES) {
    const { ms, r } = await search(engine, q)
    ;(perQuery[q] ??= []).push(ms)
    all.push(ms)
    results[q] ??= summary(r)
  }
}

const typing: number[] = []
const typed: Record<string, Result> = {}
for (const q of QUERIES) for (let n = 1; n < q.length; n++) {
  if (q[n - 1] === " ") continue
  const { ms, r } = await search(engine, q.slice(0, n))
  typing.push(ms)
  typed[q.slice(0, n)] = summary(r)
}
engine.closeSemantic()
engine.db.close()

const out = { date: new Date().toISOString(), runs, cold: stats(cold), search: stats(all), typing: stats(typing), perQuery: Object.fromEntries(Object.entries(perQuery).map(([q, xs]) => [q, quantile(xs, 0.5)])), results, typed }

console.log(`cold first search    median ${f(out.cold.median)} ms   min ${f(out.cold.min)}   max ${f(out.cold.max)}   (${coldRuns} runs)`)
console.log(`search (typical)     median ${f(out.search.median)} ms   p90 ${f(out.search.p90)}   max ${f(out.search.max)}   (${all.length} searches)`)
console.log(`typing (prefixes)    median ${f(out.typing.median)} ms   p90 ${f(out.typing.p90)}   max ${f(out.typing.max)}   (${typing.length} searches)`)
for (const [q, ms] of Object.entries(out.perQuery)) console.log(`  ${JSON.stringify(q).padEnd(34)} ${f(ms)} ms  ${results[q]!.total} results`)

const compare = args.get("compare")
if (compare) {
  const before = JSON.parse(readFileSync(compare, "utf8")) as typeof out
  console.log(`\nagainst ${compare}:`)
  for (const k of ["cold", "search", "typing"] as const) {
    console.log(`  ${k.padEnd(8)} median ${f(before[k].median)} -> ${f(out[k].median)} ms   ${(before[k].median / out[k].median).toFixed(1)}x   p90 ${(before[k].p90 / out[k].p90).toFixed(1)}x`)
  }
  // The same hits, in the same order, with the same lines; scores may differ in rounding only.
  let same = 0, maxScore = 0
  const pairs = [...Object.entries(results).map(([q, b]) => [q, before.results[q], b] as const), ...Object.entries(typed).map(([q, b]) => [q, before.typed?.[q], b] as const)]
  for (const [q, a, b] of pairs) {
    if (!a) continue
    const identical = a.total === b.total && a.strategy === b.strategy && a.hits === b.hits
    if (a.scores?.length === b.scores.length) for (let k = 0; k < b.scores.length; k++) maxScore = Math.max(maxScore, Math.abs(a.scores[k]! - b.scores[k]!))
    if (identical) { same++; continue }
    const overlap = b.top.filter((id) => a.top.includes(id)).length
    console.log(`  ${JSON.stringify(q)}: results differ (total ${a.total} -> ${b.total}, top ${TOP} overlap ${overlap}/${Math.max(a.top.length, b.top.length)}, lines ${a.hits === b.hits ? "same" : "differ"})`)
  }
  console.log(`  ${same}/${pairs.length} searches return the same hits, order, lines and counts (largest score difference ${maxScore.toExponential(1)})`)
}
const json = args.get("json")
if (json) writeFileSync(json, JSON.stringify(out, null, 1) + "\n")
process.exit(0)
