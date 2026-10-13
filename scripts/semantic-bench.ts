#!/usr/bin/env bun
/**
 * Semantic search on a public retrieval benchmark (BEIR's format), at every stage of indexing and
 * with several ways of putting words and meaning together.
 *
 *   bun run scripts/semantic-bench.ts --dataset=~/beir/scifact          # the installed models
 *   bun run scripts/semantic-bench.ts --dataset=DIR --word-vectors=vecs.txt
 *   bun run scripts/semantic-bench.ts --dataset=DIR --queries=200 --docs=20000 --json=out.json
 *
 * A dataset is a folder with `corpus.jsonl` ({_id, title, text}), `queries.jsonl` ({_id, text}) and
 * `qrels/test.tsv` (query-id, corpus-id, score), as BEIR's downloads have them
 * (https://github.com/beir-cellar/beir). Each document becomes a file in a home folder, named by
 * its title (as people name their files), holding its text.
 *
 * Stages: words only (no model) and complete Granite. Granite's stages run with the real Granite when it and
 * zsearch-embed are installed (on a Mac with the app: ZSEARCH_EMBED=/Applications/zsearch.app/
 * Contents/Helpers/zsearch-embed); with `--word-vectors` and no Granite, the stand-in plays Granite
 * (which tests the pipeline, not Granite quality). `--no-granite` skips Granite.
 *
 * Scores: nDCG@10, MRR@10 and recall@100, over the queries with judged documents.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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

/** The ways of ranking compared at each stage with a model. */
const PIPELINES: Record<string, Ranking> = {
  "DigUp (main)": DIGUP_RANKING,
  "this PR": RANKING,
  "this PR + BM25 order": { ...RANKING, strength: 0.5 },
  "this PR, no name boost": { ...RANKING, name: 0 },
  "this PR, no length/shared discount": { ...RANKING, length: 0, shared: 0 },
  "meaning and words added (DigUp + discounts, names)": { ...RANKING, everyWord: 0, coverage: 1 },
  "reciprocal rank fusion": { ...RANKING, fusion: "rrf" },
  "meaning only": { ...RANKING, words: 0 },
}

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

/** A file name of a title: what a person might have saved it as. */
const used = new Set<string>()
function fileName(doc: Record<string, string>): string {
  let stem = (doc.title || doc._id!).replace(/[/\\:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim() || doc._id!
  if (used.has(stem.toLowerCase())) stem = `${stem} (${doc._id})`
  used.add(stem.toLowerCase())
  return `${stem}.txt`
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
const results: { stage: string; pipeline: string; ndcg: number; mrr: number; recall: number; ms: number }[] = []
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
  console.error(`indexed ${docs.length} documents in ${((performance.now() - t) / 1000).toFixed(1)} s; ${queries.length} queries`)

  const run = async (stage: string, engine: SearchEngine, pipelines: Record<string, Ranking>) => {
    for (const [pipeline, ranking] of Object.entries(pipelines)) {
      engine.ranking = ranking
      const t0 = performance.now()
      const sum = { ndcg: 0, mrr: 0, recall: 0 }
      for (const q of queries) {
        const res = await engine.search(q.text!, "semantic", { limit: 100 })
        const s = scores(res.hits.map((h) => idOf.get(h.display) ?? h.display), qrels.get(q._id!)!)
        sum.ndcg += s.ndcg; sum.mrr += s.mrr; sum.recall += s.recall
      }
      const n = Math.max(queries.length, 1)
      const row = { stage, pipeline, ndcg: sum.ndcg / n, mrr: sum.mrr / n, recall: sum.recall / n, ms: (performance.now() - t0) / n }
      results.push(row)
      console.log(`${stage.padEnd(26)} ${pipeline.padEnd(52)} nDCG@10 ${row.ndcg.toFixed(3)}  MRR@10 ${row.mrr.toFixed(3)}  R@100 ${row.recall.toFixed(3)}  ${row.ms.toFixed(0)} ms`)
    }
  }
  const engineWith = () => {
    const e = new SearchEngine(db, config)
    if (!graniteReal) e.embedQuery = async (text) => (await standIn!.embedTexts([text])).vectors
    return e
  }

  // Words only.
  const words = new SearchEngine(db, config)
  words.embedQuery = null
  await run("words only", words, { "words only": RANKING, "words only, before BM25 order and coverage": { ...RANKING, keywordCoverage: 0, keywordStrength: 0, keywordCover: undefined }, "words only, no name boost": { ...RANKING, keywordName: 0 } })

  if (granite) {
    t = performance.now()
    const full = await new SemanticIndexer(db, config, graniteReal ? tool : null, graniteReal ? {} : { embedder: () => standIn!, vectorVersion: 2 }).run()
    if (full.status !== "done") throw new Error(`Granite's pass: ${full.status} ${full.error ?? ""}`)
    console.error(`Granite (${granite}) read them in ${((performance.now() - t) / 1000).toFixed(1)} s`)
    const label = granite === "real" ? "Granite" : "Granite (stand-in)"
    const engine = engineWith()
    try { await run(label, engine, PIPELINES) } finally { engine.closeSemantic() }

  }
  if (args.get("json")) writeFileSync(args.get("json")!, JSON.stringify({ dataset, docs: docs.length, queries: queries.length, granite, results }, null, 2))
  db.close()
} finally {
  standIn?.close()
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  if (!args.has("keep")) rmSync(home, { recursive: true, force: true })
}
