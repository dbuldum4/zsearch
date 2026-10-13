#!/usr/bin/env bun
/**
 * How well semantic search answers questions about a small home folder (`semantic-eval/corpus.ts`),
 * against find (keyword search) on the same index.
 *
 *   bun run scripts/semantic-eval.ts                           # Potion, as installed
 *   ZSEARCH_MODELS=~/models/potion bun run scripts/semantic-eval.ts
 *   bun run scripts/semantic-eval.ts --word-vectors=vecs.txt   # a stand-in for Potion
 *   bun run scripts/semantic-eval.ts --json=out.json --verbose
 *
 * Only Potion's pass runs (Granite's is what this measures until it has read the files). Without
 * Potion, `--word-vectors` takes a text file of "word v1 v2 …" lines: a static model that, like
 * Potion, averages its words' vectors.
 *
 * The folder also holds the READMEs, changelogs and licences of the packages in node_modules (in
 * Downloads/packages), as a home folder holds many files that answer none of the questions.
 *
 * Each question is searched in the semantic tab twice: with words only (as before Potion has read
 * anything: "keyword"), and with Potion ("semantic"). Scores per question type and overall:
 * nDCG@10 (graded), MRR, recall@10, and how many of the top five are noise (a file the corpus
 * doesn't list, a licence, a changelog, a long manual or handbook, a Lean proof).
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Glob } from "bun"
import { defaultConfig } from "../src/config.ts"
import { openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine } from "../src/search/engine.ts"
import type { TextEmbedder } from "../src/semantic/helper.ts"
import { SemanticIndexer } from "../src/semantic/indexer.ts"
import { installedModel, POTION } from "../src/semantic/model.ts"
import { normalize, PotionEmbedder, PotionModel, preTokenize } from "../src/semantic/potion.ts"
import { FILES, QUESTIONS, type Question } from "./semantic-eval/corpus.ts"

const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k!, v ?? "true"] as const }))
const K = 10

/** Common words a static model's own weights make all but silent. */
const STOP = new Set("a an the of in on at to for with and or my me i is was are were be it its this that these those from by as do does did how what when where which who why much many there their our your his her he she they we you".split(" "))

/** A static model of word vectors: the weighted average of the text's words' vectors, centred and normalized. */
class WordVectors implements TextEmbedder {
  private vectors = new Map<string, Float32Array>()
  private mean: Float32Array
  constructor(path: string) {
    let dim = 0
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const parts = line.split(" ")
      if (parts.length < 10) continue
      // "word [row] v1 v2 …": a row number, when there is one, is skipped.
      const nums = parts.slice(1).map(Number)
      const v = Float32Array.from(nums.length % 2 === 1 ? nums.slice(1) : nums)
      dim = v.length
      this.vectors.set(parts[0]!, v)
    }
    this.mean = new Float32Array(dim)
    for (const v of this.vectors.values()) for (let d = 0; d < dim; d++) this.mean[d]! += v[d]! / this.vectors.size
  }
  async embedTexts(texts: string[]) {
    const dim = this.mean.length
    const out = new Float32Array(texts.length * dim)
    let tokens = 0
    texts.forEach((t, i) => {
      const o = out.subarray(i * dim, (i + 1) * dim)
      for (const w of preTokenize(normalize(t)).slice(0, 512)) {
        const v = this.vectors.get(w)
        if (!v) continue
        tokens++
        const weight = STOP.has(w) ? 0.15 : 1
        for (let d = 0; d < dim; d++) o[d]! += (v[d]! - this.mean[d]!) * weight
      }
      let n = 0
      for (const x of o) n += x * x
      if (n > 0) for (let d = 0; d < dim; d++) o[d]! /= Math.sqrt(n)
    })
    return { vectors: out, dim, tokens }
  }
  close() {}
  kill() {}
}

function embedder(): { model: TextEmbedder; name: string } {
  const vectors = args.get("word-vectors")
  if (vectors) return { model: new WordVectors(vectors), name: `word vectors (${vectors})` }
  const files = installedModel(POTION)
  if (!files) throw new Error("Potion is not installed: run `zsearch semantic install`, set ZSEARCH_MODELS, or pass --word-vectors")
  return { model: new PotionEmbedder(PotionModel.load(files[0]!, files[1]!)), name: POTION.name }
}

const isNoise = (path: string) => !(path in FILES) || /(^|\/)(LICENSE|CHANGELOG\.md)$|handbook|manual|\.lean$/.test(path)

function scores(q: Question, ranked: string[]) {
  const dcg = ranked.slice(0, K).reduce((s, p, i) => s + ((2 ** (q.relevant[p] ?? 0) - 1) / Math.log2(i + 2)), 0)
  const ideal = Object.values(q.relevant).sort((a, b) => b - a).slice(0, K).reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0)
  const first = ranked.findIndex((p) => q.relevant[p])
  const found = Object.keys(q.relevant).filter((p) => ranked.slice(0, K).includes(p)).length
  return { ndcg: dcg / ideal, mrr: first < 0 ? 0 : 1 / (first + 1), recall: found / Object.keys(q.relevant).length, noise: ranked.slice(0, 5).filter(isNoise).length }
}

const home = mkdtempSync(join(tmpdir(), "zsearch-eval-"))
const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME }
try {
  process.env.HOME = home
  process.env.ZSEARCH_HOME = join(home, ".zsearch-data")
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(home, rel)), { recursive: true })
    writeFileSync(join(home, rel), text)
  }
  const modules = join(import.meta.dir, "..", "node_modules")
  let packages = 0
  for (const file of new Glob("**/{README,CHANGELOG,LICENSE,HISTORY}*").scanSync({ cwd: modules, onlyFiles: true })) {
    const to = join(home, "Downloads", "packages", file.replaceAll("/", "_"))
    cpSync(join(modules, file), to)
    packages++
  }
  const config = { ...defaultConfig(), roots: ["~"], semantic: { enabled: true, declined: false, code: false } }
  const db = openDb(join(home, ".zsearch-data", "index.db"))
  await new Indexer(db, config, { inProcess: true }).run()
  const { model, name } = embedder()
  const run = await new SemanticIndexer(db, config, null, { tier: "fast", embedder: () => model, vectorVersion: 1 }).run()
  if (run.status !== "done") throw new Error(`the Potion pass ended with ${run.status}: ${run.error ?? ""}`)
  const engine = new SearchEngine(db, config)
  engine.embedQuery = async (text) => (await model.embedTexts([text])).vectors
  const words = new SearchEngine(db, config)
  words.embedQuery = null

  const modes = ["keyword", "semantic"] as const
  const rows: Record<string, Record<string, ReturnType<typeof scores>[]>> = {}
  const detail: unknown[] = []
  for (const q of QUESTIONS) {
    for (const mode of modes) {
      const res = await (mode === "keyword" ? words : engine).search(q.q, "semantic", { limit: 50 })
      const ranked = res.hits.map((h) => h.display)
      const s = scores(q, ranked)
      for (const type of [q.type, "all"]) ((rows[mode] ??= {})[type] ??= []).push(s)
      detail.push({ q: q.q, mode, ...s, top: ranked.slice(0, 5) })
      if (args.has("verbose")) console.log(`${mode.padEnd(8)} ${q.q.padEnd(34)} ndcg ${s.ndcg.toFixed(2)}  ${ranked.slice(0, 5).join(", ")}`)
    }
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
  console.log(`\n${name}, ${Object.keys(FILES).length} files and ${packages} package documents, ${QUESTIONS.length} questions\n`)
  console.log("mode      type      n   nDCG@10  MRR    R@10   noise in top 5")
  const summary: Record<string, unknown> = {}
  for (const mode of modes) for (const type of ["words", "mixed", "meaning", "all"]) {
    const xs = rows[mode]![type]!
    const line = { n: xs.length, ndcg: avg(xs.map((x) => x.ndcg)), mrr: avg(xs.map((x) => x.mrr)), recall: avg(xs.map((x) => x.recall)), noise: avg(xs.map((x) => x.noise)) }
    summary[`${mode}/${type}`] = line
    console.log(`${mode.padEnd(9)} ${type.padEnd(8)} ${String(line.n).padStart(3)}   ${line.ndcg.toFixed(3)}   ${line.mrr.toFixed(3)}  ${line.recall.toFixed(3)}  ${line.noise.toFixed(2)}`)
  }
  if (args.get("json")) writeFileSync(args.get("json")!, JSON.stringify({ model: name, summary, detail }, null, 2))
  engine.closeSemantic()
  db.close()
} finally {
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  rmSync(home, { recursive: true, force: true })
}
