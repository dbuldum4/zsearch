#!/usr/bin/env bun
/** Small retrieval-quality evaluation with real models and package-document distractors.
 * bun scripts/semantic-eval.ts --stage=all --json=results.json [--pdf-dir=DIR] [--holdout | --audit]
 * --word-vectors=FILE explicitly substitutes static vectors; reports label this as a stand-in.
 * --stage=words needs no model. --stage=all runs words, Potion and complete Granite.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { Glob } from "bun"
import { defaultConfig } from "../src/config.ts"
import { openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { Embedder, embedToolPath, type TextEmbedder } from "../src/semantic/helper.ts"
import { SemanticIndexer } from "../src/semantic/indexer.ts"
import { GRANITE, installedModel, POTION } from "../src/semantic/model.ts"
import { PotionEmbedder, PotionModel } from "../src/semantic/potion.ts"
import { WordVectors } from "./semantic-eval/word-vectors.ts"
import { FILES, QUESTIONS, type Question } from "./semantic-eval/corpus.ts"
import { AUDIT_QUESTIONS, HOLDOUT_FILES, HOLDOUT_QUESTIONS } from "./semantic-eval/holdout.ts"

const args = new Map(process.argv.slice(2).map(a => { const i = a.indexOf("="); return i < 0 ? [a.replace(/^--/, ""), "true"] : [a.slice(2, i), a.slice(i + 1)] }))
const stage = args.get("stage") ?? (args.has("granite") ? "full" : "all")
if (!["all", "words", "potion", "full"].includes(stage)) throw new Error("--stage must be all, words, potion or full")
if (args.has("granite") && !["true", "1"].includes(args.get("granite")!)) throw new Error("Partial Granite is no longer a search stage; use --stage=potion or --stage=full")
const pdfNames = ["ACT-UserHandbook.pdf", "SHS Handbook 26-27.pdf"]
const localPath = (value: string) => resolve(value.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"))
const pdfDir = args.get("pdf-dir") ? localPath(args.get("pdf-dir")!) : null
const pdfs = pdfDir ? pdfNames.filter(name => existsSync(join(pdfDir, name))) : []
const source = { ...FILES, ...((args.has("holdout") || args.has("audit")) ? HOLDOUT_FILES : {}) }
const questions: Question[] = structuredClone(args.has("audit") ? AUDIT_QUESTIONS : args.has("holdout") ? HOLDOUT_QUESTIONS : QUESTIONS)
if (!args.has("holdout") && !args.has("audit") && pdfs.length) {
  Object.assign(questions.find(q => q.q === "handbook")!.relevant, Object.fromEntries(pdfs.map(name => [`Downloads/${name}`, 2])))
  questions.push({ q: "handbook type:pdf", type: "words", relevant: Object.fromEntries(pdfs.map(name => [`Downloads/${name}`, 2])) })
  if (pdfs.includes(pdfNames[1]!)) questions.push({ q: "SHS handbook", type: "words", relevant: { "Downloads/SHS Handbook 26-27.pdf": 2 } })
  if (pdfs.includes(pdfNames[0]!)) questions.push({ q: "ACT user handbook", type: "words", relevant: { "Downloads/ACT-UserHandbook.pdf": 2 } })
}
const queries = questions.filter(q => Object.keys(q.relevant).every(path => path in source || pdfs.some(name => path === `Downloads/${name}`)))
const vectors = args.get("word-vectors") ? localPath(args.get("word-vectors")!) : undefined
// Resolve model paths before redirecting zsearch's data to the temporary corpus.
const potionFiles = installedModel(POTION), graniteFiles = installedModel(GRANITE)
const tool = args.get("tool") ? localPath(args.get("tool")!) : embedToolPath()
const potionModel = !vectors && potionFiles && stage !== "words" ? PotionModel.load(potionFiles[0]!, potionFiles[1]!) : null
const makePotion = (): TextEmbedder => vectors ? new WordVectors(vectors) : potionModel ? new PotionEmbedder(potionModel) : (() => { throw new Error("Potion is not installed; install it or set ZSEARCH_MODELS") })()
const makeGranite = (): TextEmbedder => vectors ? new WordVectors(vectors) : tool && graniteFiles ? new Embedder({ tool, model: graniteFiles[0]!, pooling: "cls", threads: Math.min(4, availableParallelism()), batchTokens: 2048, maxSeqs: 16 }) : (() => { throw new Error("Granite or its helper is missing; install them or set --tool and ZSEARCH_MODELS") })()

function scores(q: Question, ranked: string[]) {
  const gain = (g: number) => 2 ** g - 1
  const dcg = ranked.slice(0, 10).reduce((sum, path, i) => sum + gain(q.relevant[path] ?? 0) / Math.log2(i + 2), 0)
  const ideal = Object.values(q.relevant).sort((a, b) => b - a).slice(0, 10).reduce((sum, g, i) => sum + gain(g) / Math.log2(i + 2), 0)
  const first = ranked.slice(0, 10).findIndex(path => !!q.relevant[path])
  return { ndcg: dcg / ideal, mrr: first < 0 ? 0 : 1 / (first + 1), recall: Object.keys(q.relevant).filter(path => ranked.slice(0, 10).includes(path)).length / Object.keys(q.relevant).length }
}
const home = mkdtempSync(join(tmpdir(), "zsearch-quality-"))
const previousData = process.env.ZSEARCH_HOME
const details: { stage: string; q: string; type: string; ndcg: number; mrr: number; recall: number; top: string[]; hits: unknown[] }[] = []
const summary: Record<string, { n: number; ndcg: number; mrr: number; recall: number }> = {}
const embedders: TextEmbedder[] = []
let db: ReturnType<typeof openDb> | undefined
try {
  process.env.ZSEARCH_HOME = join(home, ".data")
  for (const [path, text] of Object.entries(source)) { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), text) }
  for (const name of pdfs) { mkdirSync(join(home, "Downloads"), { recursive: true }); cpSync(join(pdfDir!, name), join(home, "Downloads", name)) }
  let packages = 0
  const modules = join(import.meta.dir, "..", "node_modules")
  for (const file of [...new Glob("**/{README,CHANGELOG,LICENSE,HISTORY}*").scanSync({ cwd: modules, onlyFiles: true })].sort()) {
    const to = join(home, "Downloads", "packages", file.replaceAll("/", "_")); mkdirSync(dirname(to), { recursive: true }); cpSync(join(modules, file), to); packages++
  }
  const config = { ...defaultConfig(), roots: [join(home, "Documents"), join(home, "Downloads"), join(home, "Projects")], semantic: { enabled: true, declined: false, code: false } }
  db = openDb(join(home, ".data", "index.db"))
  await new Indexer(db, config, { inProcess: true }).run()
  console.log(`${Object.keys(source).length + pdfs.length} files + ${packages} package documents; ${queries.length} ${args.has("audit") ? "audit" : args.has("holdout") ? "validation" : "tuning"} queries; ${vectors ? `stand-in (${basename(vectors)})` : "real models"}`)
  const run = async (label: string, fast: TextEmbedder | null, full: TextEmbedder | null) => {
    const engine = new SearchEngine(db!, config)
    engine.embedQuery = fast ? async (text, tier) => {
      const model = tier === "full" ? full : fast
      if (!model) throw new Error("Granite is not active in this stage")
      return (await model.embedTexts([text])).vectors
    } : null
    try {
      for (const q of queries) {
        const res = await engine.search(q.q, "semantic", { limit: 50 })
        if (res.error) throw new Error(res.error)
        const ranked = res.hits.map(hit => relative(home, hit.path))
        const s = scores(q, ranked)
        details.push({ stage: label, q: q.q, type: q.type, ...s, top: ranked.slice(0, 10), hits: res.hits.slice(0, 5).map(h => ({ display: relative(home, h.path), lines: h.lines, score: h.score, sources: h.sources })) })
        if (args.has("verbose")) console.log(`${label.padEnd(7)} ${q.q.padEnd(38)} ${s.ndcg.toFixed(3)} ${ranked.slice(0, 3).join(", ")}`)
      }
      for (const type of ["words", "mixed", "meaning", "all"]) {
        const rows = details.filter(d => d.stage === label && (type === "all" || d.type === type))
        if (!rows.length) continue
        const n = rows.length, avg = (key: "ndcg" | "mrr" | "recall") => rows.reduce((sum, row) => sum + row[key], 0) / n
        const row = { n, ndcg: avg("ndcg"), mrr: avg("mrr"), recall: avg("recall") }; summary[`${label}/${type}`] = row
        console.log(`${label.padEnd(7)} ${type.padEnd(7)} n=${n} nDCG@10=${row.ndcg.toFixed(3)} MRR@10=${row.mrr.toFixed(3)} R@10=${row.recall.toFixed(3)}`)
      }
    } finally { engine.closeSemantic() }
  }
  if (stage === "all" || stage === "words") await run("words", null, null)
  if (stage !== "words") {
    const indexed = await new SemanticIndexer(db, config, null, { tier: "fast", embedder: makePotion, vectorVersion: 1 }).run()
    if (indexed.status !== "done") throw new Error(`Potion indexing: ${indexed.status} ${indexed.error ?? ""}`)
    const fast = makePotion(); embedders.push(fast)
    if (stage === "all" || stage === "potion") await run("potion", fast, null)
    if (stage === "all" || stage === "full") {
      const indexed = await new SemanticIndexer(db, config, tool, { tier: "full", embedder: makeGranite, vectorVersion: 1 }).run()
      if (indexed.status !== "done") throw new Error(`Granite indexing: ${indexed.status} ${indexed.error ?? ""}`)
      const full = makeGranite(); embedders.push(full)
      await run("full", fast, full)
    }
  }
  if (args.get("json")) writeFileSync(args.get("json")!, JSON.stringify({ source: vectors ? "stand-in" : "real models", files: Object.keys(source).length + pdfs.length, packages, set: args.has("audit") ? "audit" : args.has("holdout") ? "validation" : "tuning", summary, detail: details }, null, 2))
} finally {
  for (const model of embedders) model.close()
  db?.close()
  if (previousData === undefined) delete process.env.ZSEARCH_HOME; else process.env.ZSEARCH_HOME = previousData
  rmSync(home, { recursive: true, force: true })
}
