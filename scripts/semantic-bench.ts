#!/usr/bin/env bun
/**
 * Semantic search on a public retrieval benchmark (BEIR's format), words only and with complete
 * Granite, under several ways of putting words and meaning together.
 *
 *   bun scripts/bench-data.ts scifact                          # fetch a set (see --list there)
 *   bun scripts/semantic-bench.ts --dataset=~/Library/Caches/zsearch-bench/scifact
 *   bun scripts/semantic-bench.ts --dataset=DIR --queries=300 --pipelines=current,model --json=out.json
 *
 * A dataset is a folder with `corpus.jsonl` ({_id, title, text}), `queries.jsonl` ({_id, text}) and
 * `qrels/test.tsv` (query-id, corpus-id, score), as BEIR's downloads have them, and optionally the
 * `meta.json` `bench-data.ts` writes (the extension documents are saved with, how they are named,
 * and MTEB's published score for Granite small). Each document becomes a file in a home folder:
 * named by its title (`--names=title`, as people name saved papers and mail) or by its id
 * (`--names=id`, so names say nothing; the default when the set has no titles).
 *
 * Pipelines (`--pipelines=a,b`, default all):
 *   current       zsearch's ranking (RANKING)
 *   previous      the ranking before IDF-weighted coverage at 1.5 (plain coverage at 0.5)
 *   model         the model alone: each file's best passage, no gate, discount, words or names;
 *                 the closest to how MTEB scores the model (it embeds whole documents instead)
 *   meaning       meaning only, with zsearch's gate and length/shared discounts
 *   bm25          current + keyword search's BM25 order of the word matches
 *   no-name       current without the name boost
 *   no-discount   current without the length and shared-passage discounts
 *   rrf           reciprocal rank fusion of the word and meaning orders
 *   digup         DigUp's ranking
 * and without a model: words, words-plain (no BM25 order or coverage weights), words-no-name.
 * `--no-granite` runs only the word pipelines.
 *
 * Scores: nDCG@10, MRR@10 and recall@100 over the queries with judged documents (a document with the
 * query's own id is skipped, as BEIR's evaluation does), the share of
 * queries with no results, and milliseconds per query. `--json` also keeps every query's scores,
 * for `bench-compare.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig } from "../src/config.ts"
import { openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { embedToolPath } from "../src/semantic/helper.ts"
import { SemanticIndexer } from "../src/semantic/indexer.ts"
import { GRANITE, installedModel, modelDir } from "../src/semantic/model.ts"
import { DIGUP_RANKING, RANKING, type Ranking } from "../src/semantic/search.ts"
import { WordVectors } from "./semantic-eval/word-vectors.ts"

const args = new Map(process.argv.slice(2).map((a) => { const i = a.indexOf("="); return i < 0 ? [a.replace(/^--/, ""), "true"] as const : [a.slice(2, i), a.slice(i + 1)] as const }))
const dataset = (args.get("dataset") ?? "").replace(/^~/, process.env.HOME ?? "~")
if (!dataset) throw new Error("--dataset=DIR is required")
const maxQueries = Number(args.get("queries") ?? Infinity)
const maxDocs = Number(args.get("docs") ?? Infinity)
const meta = existsSync(join(dataset, "meta.json")) ? JSON.parse(readFileSync(join(dataset, "meta.json"), "utf8")) as { ext?: string; names?: "title" | "id"; reference?: { ndcg: number; recall: number; task: string } | null } : {}
const ext = meta.ext ?? "txt"

/** The ways of ranking compared with a model. */
const PIPELINES: Record<string, Ranking> = {
  current: RANKING,
  previous: { ...RANKING, idf: false, coverage: 0.5 },
  model: { ...RANKING, words: 0, length: 0, shared: 0, zGate: -Infinity },
  meaning: { ...RANKING, words: 0 },
  bm25: { ...RANKING, strength: 0.5 },
  "no-name": { ...RANKING, name: 0 },
  "no-discount": { ...RANKING, length: 0, shared: 0 },
  rrf: { ...RANKING, fusion: "rrf" },
  digup: DIGUP_RANKING,
}
/** ...and without one. */
const WORD_PIPELINES: Record<string, Ranking> = {
  words: RANKING,
  "words-plain": { ...RANKING, keywordCoverage: 0, keywordStrength: 0, keywordCover: undefined },
  "words-no-name": { ...RANKING, keywordName: 0 },
}
const selected = args.get("pipelines")?.split(",")
for (const name of selected ?? []) if (!PIPELINES[name] && !WORD_PIPELINES[name]) throw new Error(`unknown pipeline ${name}`)
const pick = (all: Record<string, Ranking>) => Object.fromEntries(Object.entries(all).filter(([name]) => !selected || selected.includes(name)))

/* ------------------------------------------------------------ the data -- */

const readJsonl = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>)
const docs = readJsonl(join(dataset, "corpus.jsonl")).slice(0, maxDocs)
const qrels = new Map<string, Map<string, number>>()
for (const line of readFileSync(join(dataset, "qrels", "test.tsv"), "utf8").split("\n").slice(1)) {
  const [q, d, s] = line.split("\t")
  if (!q || !d || !(Number(s) > 0)) continue
  if (!qrels.has(q)) qrels.set(q, new Map())
  qrels.get(q)!.set(d, Number(s))
}
const kept = new Set(docs.map((d) => d._id!))
const queries = readJsonl(join(dataset, "queries.jsonl"))
  .filter((q) => [...(qrels.get(q._id!)?.keys() ?? [])].some((d) => kept.has(d)))
  .slice(0, maxQueries)
const names = (args.get("names") ?? meta.names ?? (docs.some((d) => d.title) ? "title" : "id")) as "title" | "id"
if (names !== "title" && names !== "id") throw new Error("--names must be title or id")

/** A file name for a document: its title, as a person might have saved it, or its id. */
const used = new Set<string>()
function fileName(doc: Record<string, string>): string {
  let stem = (names === "title" && doc.title ? doc.title : doc._id!).replace(/[/\\:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim() || doc._id!
  if (used.has(stem.toLowerCase())) stem = `${stem} (${doc._id})`
  used.add(stem.toLowerCase())
  return `${stem}.${ext}`
}

/* ----------------------------------------------------------- the models -- */

const vectorsPath = args.get("word-vectors")
const standIn = vectorsPath ? new WordVectors(vectorsPath) : null
const tool = embedToolPath()
const graniteReal = !!(tool && installedModel(GRANITE)) && !args.has("no-granite")
if (!graniteReal && !standIn && !args.has("no-granite")) throw new Error("Granite or its helper is not installed: run `zsearch semantic install`, build the helper, or pass --word-vectors")
const granite: "real" | "stand-in" | null = args.has("no-granite") ? null : graniteReal ? "real" : standIn ? "stand-in" : null
/** Where the installed models are, before the run moves zsearch's data folder. */
const modelDirs = [GRANITE].filter((m) => installedModel(m)).map((m) => [m.folder, modelDir(m)] as const)

/* ------------------------------------------------------------ the runs -- */

function scores(ranked: string[], rel: Map<string, number>) {
  const gain = (g: number) => 2 ** g - 1
  const dcg = ranked.slice(0, 10).reduce((s, d, i) => s + gain(rel.get(d) ?? 0) / Math.log2(i + 2), 0)
  const ideal = [...rel.values()].sort((a, b) => b - a).slice(0, 10).reduce((s, g, i) => s + gain(g) / Math.log2(i + 2), 0)
  const first = ranked.slice(0, 10).findIndex((d) => rel.has(d))
  const found = [...rel.keys()].filter((d) => ranked.slice(0, 100).includes(d)).length
  return { ndcg: ideal ? dcg / ideal : 0, mrr: first < 0 ? 0 : 1 / (first + 1), recall: found / rel.size }
}

const home = mkdtempSync(join(process.env.ZSEARCH_BENCH_TMP || tmpdir(), "zsearch-bench-"))
const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME }
type Row = { stage: string; pipeline: string; ndcg: number; mrr: number; recall: number; empty: number; ms: number }
const results: Row[] = []
/** Per query, per pipeline: nDCG@10, MRR@10, recall@100. */
const perQuery: Record<string, Record<string, [number, number, number]>> = {}
const timing: Record<string, number> = {}
try {
  process.env.HOME = home
  process.env.ZSEARCH_HOME = join(home, ".zsearch-data")
  if (!process.env.ZSEARCH_MODELS) {
    mkdirSync(join(home, ".zsearch-data", "models"), { recursive: true })
    for (const [folder, dir] of modelDirs) symlinkSync(dir, join(home, ".zsearch-data", "models", folder))
  }
  const idOf = new Map<string, string>()
  mkdirSync(join(home, "Documents"), { recursive: true })
  for (const d of docs) {
    const name = fileName(d)
    idOf.set(`Documents/${name}`, d._id!)
    writeFileSync(join(home, "Documents", name), d.text ?? "")
  }
  const config = { ...defaultConfig(), roots: ["~"], semantic: { enabled: true, declined: false, code: false } }
  const db = openDb(join(home, ".zsearch-data", "index.db"))
  let t = performance.now()
  await new Indexer(db, config, { inProcess: true }).run()
  timing.indexSeconds = (performance.now() - t) / 1000
  console.error(`${dataset}: ${docs.length} documents as .${ext} named by ${names}, indexed in ${timing.indexSeconds.toFixed(1)} s; ${queries.length} queries`)

  const run = async (stage: string, engine: SearchEngine, pipelines: Record<string, Ranking>) => {
    for (const [pipeline, ranking] of Object.entries(pipelines)) {
      engine.ranking = ranking
      // The query vectors are cached after the first pipeline: time the rest without the model.
      const t0 = performance.now()
      const sum = { ndcg: 0, mrr: 0, recall: 0, empty: 0 }
      for (const q of queries) {
        const res = await engine.search(q.text!, "semantic", { limit: 100 })
        if (res.error) throw new Error(`${q._id}: ${res.error}`)
        // As BEIR's evaluation: a document with the query's own id is the query (ArguAna), not a result.
        const s = scores(res.hits.map((h) => idOf.get(h.display) ?? h.display).filter((id) => id !== q._id), qrels.get(q._id!)!)
        sum.ndcg += s.ndcg; sum.mrr += s.mrr; sum.recall += s.recall; sum.empty += res.hits.length ? 0 : 1
        ;(perQuery[q._id!] ??= {})[pipeline] = [+s.ndcg.toFixed(4), +s.mrr.toFixed(4), +s.recall.toFixed(4)]
      }
      const n = Math.max(queries.length, 1)
      const row = { stage, pipeline, ndcg: sum.ndcg / n, mrr: sum.mrr / n, recall: sum.recall / n, empty: sum.empty / n, ms: (performance.now() - t0) / n }
      results.push(row)
      console.log(`${stage.padEnd(8)} ${pipeline.padEnd(14)} nDCG@10 ${row.ndcg.toFixed(3)}  MRR@10 ${row.mrr.toFixed(3)}  R@100 ${row.recall.toFixed(3)}  empty ${(row.empty * 100).toFixed(1)}%  ${row.ms.toFixed(0)} ms`)
    }
  }

  const words = new SearchEngine(db, config)
  words.embedQuery = null
  await run("words", words, pick(WORD_PIPELINES))

  if (granite && Object.keys(pick(PIPELINES)).length) {
    t = performance.now()
    const full = await new SemanticIndexer(db, config, graniteReal ? tool : null, graniteReal ? {} : { embedder: () => standIn!, vectorVersion: 2 }).run()
    if (full.status !== "done") throw new Error(`Granite's pass: ${full.status} ${full.error ?? ""}`)
    timing.graniteSeconds = (performance.now() - t) / 1000
    timing.passages = full.embedded + full.reused
    console.error(`Granite (${granite}) read them in ${timing.graniteSeconds.toFixed(1)} s (${full.embedded} passages embedded, ${full.reused} reused)`)
    const engine = new SearchEngine(db, config)
    if (!graniteReal) engine.embedQuery = async (text) => (await standIn!.embedTexts([text])).vectors
    try { await run(granite === "real" ? "granite" : "stand-in", engine, pick(PIPELINES)) } finally { engine.closeSemantic() }
  }
  if (meta.reference) console.log(`MTEB, Granite small alone (${meta.reference.task}): nDCG@10 ${meta.reference.ndcg.toFixed(3)}  R@100 ${meta.reference.recall.toFixed(3)}`)
  if (args.get("json")) writeFileSync(args.get("json")!, JSON.stringify({ dataset, docs: docs.length, queries: queries.length, names, ext, granite, reference: meta.reference ?? null, timing, results, perQuery }, null, 2))
  db.close()
} finally {
  standIn?.close()
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  if (!args.has("keep")) rmSync(home, { recursive: true, force: true })
}
