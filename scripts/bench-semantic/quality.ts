/**
 * What the stored vectors cost in results, with the real model: the eval queries in evals.json
 * against their documents among a few thousand distractor passages (this repository's Markdown
 * and scripts/bench.ts's generated prose), ranked by the full 32-bit vectors, by the vectors as
 * zsearch stores them (16-bit floats, as DigUp does), and by 8-bit integers with a scale each
 * (half the size; zsearch stored those at first).
 *
 *   bun scripts/bench-semantic/quality.ts --model=MODEL.gguf [--tool=dist/zsearch-embed]
 *       [--distractors=2000] [--json=OUT] [--min-overlap=0.99]
 *
 * Ranking by meaning alone orders a query's passages by cosine (DigUp's z-score is the same
 * order), so the top-10 overlap here is the overlap of what semantic search shows. Exits 1 if
 * the stored vectors agree with full precision on less than --min-overlap of the top 10, or if
 * packing passages into one model call moves any vector below DigUp's 0.999 cosine.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chunkText, documentPrompt, queryPrompt, titleOf } from "../../src/semantic/chunk.ts"
import { Embedder, embedToolPath } from "../../src/semantic/helper.ts"
import { packVector, vectorValues } from "../../src/semantic/store.ts"
import { makeCorpus } from "../bench.ts"

const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k!, v ?? "true"] as [string, string] }))
const MODEL = args.get("model")
const TOOL = args.get("tool") ?? embedToolPath()
const DISTRACTORS = Number(args.get("distractors") ?? 2000)
const MIN_OVERLAP = Number(args.get("min-overlap") ?? 0.99)
if (!MODEL || !existsSync(MODEL) || !TOOL) {
  console.error("usage: bun scripts/bench-semantic/quality.ts --model=MODEL.gguf [--tool=dist/zsearch-embed] [--distractors=2000]")
  process.exit(2)
}
const log = (s: string) => console.error(s)
const repo = join(import.meta.dir, "../..")

const evals = (JSON.parse(readFileSync(join(import.meta.dir, "evals.json"), "utf8")) as { items: { title: string; text: string; query: string }[] }).items
const docs = evals.map((e) => documentPrompt(e.title, e.text))

// Distractors: real prose first, then generated text.
const distractors: string[] = []
const addFile = (path: string) => {
  const text = readFileSync(path, "utf8")
  for (const c of chunkText(text)) if (distractors.length < DISTRACTORS) distractors.push(documentPrompt(titleOf(path.split("/").pop()!), text.slice(c.start, c.end)))
}
const walk = (dir: string, re: RegExp, skip: RegExp) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (skip.test(name)) continue
    statSync(p).isDirectory() ? walk(p, re, skip) : re.test(name) && addFile(p)
  }
}
walk(repo, /\.md$/, /^(node_modules|vendor|dist|\..*)$/)
const work = mkdtempSync(join(tmpdir(), "zsearch-quality-"))
makeCorpus(work, 400, 7)
walk(work, /\.(md|txt)$/, /^$/)
rmSync(work, { recursive: true, force: true })

const all = [...docs, ...distractors]
log(`embedding ${evals.length} queries and ${all.length} passages (${docs.length} answers, ${distractors.length} distractors)`)
const embedder = new Embedder({ tool: TOOL, model: MODEL, pooling: "cls" })
const t = performance.now()
const P = await embedder.embedTexts(all)
const Q = await embedder.embedTexts(evals.map((e) => queryPrompt(e.query)))
const embedSeconds = (performance.now() - t) / 1000
embedder.close()
const dim = P.dim
const n = all.length

// Packed with other passages against one at a time, for the answers.
const single = new Embedder({ tool: TOOL, model: MODEL, extra: ["--no-sort", "--max-seqs", "1"] })
const S = await single.embedTexts(docs)
single.close()
let packedWorst = 1
for (let i = 0; i < docs.length; i++) {
  let dot = 0
  for (let d = 0; d < dim; d++) dot += P.vectors[i * dim + d]! * S.vectors[i * dim + d]!
  packedWorst = Math.min(packedWorst, dot)
}

const stored = (v: Float32Array) => {
  const out = new Float32Array(v.length)
  for (let r = 0; r < v.length / dim; r++) out.set(vectorValues(packVector(v, r * dim, dim), dim)!, r * dim)
  return out
}
const int8 = (v: Float32Array) => {
  const out = new Float32Array(v.length)
  for (let r = 0; r < v.length / dim; r++) {
    let max = 0
    for (let i = 0; i < dim; i++) max = Math.max(max, Math.abs(v[r * dim + i]!))
    const scale = max > 0 ? max / 127 : 1
    for (let i = 0; i < dim; i++) out[r * dim + i] = Math.round(v[r * dim + i]! / scale) * scale
  }
  return out
}
const scores = (vecs: Float32Array) => evals.map((_, q) => {
  const s = new Float64Array(n)
  for (let r = 0; r < n; r++) { let dot = 0; for (let i = 0; i < dim; i++) dot += Q.vectors[q * dim + i]! * vecs[r * dim + i]!; s[r] = dot }
  return s
})
const top = (s: Float64Array, k: number) => Array.from(s.keys()).sort((a, b) => s[b]! - s[a]!).slice(0, k)

const ranked = { f32: scores(P.vectors), stored: scores(stored(P.vectors)), int8: scores(int8(P.vectors)) }
const quality = (name: keyof typeof ranked) => {
  let at1 = 0, at5 = 0, mrr = 0
  ranked[name].forEach((s, q) => {
    const order = top(s, n)
    const rank = order.indexOf(q) + 1
    if (rank === 1) at1++
    if (rank <= 5) at5++
    mrr += 1 / rank
  })
  return { recallAt1: +(at1 / evals.length).toFixed(3), recallAt5: +(at5 / evals.length).toFixed(3), mrr: +(mrr / evals.length).toFixed(3) }
}
const agreement = (a: keyof typeof ranked, b: keyof typeof ranked) => {
  let overlap = 0, same1 = 0, maxError = 0
  for (let q = 0; q < evals.length; q++) {
    const x = top(ranked[a][q]!, 10), y = top(ranked[b][q]!, 10)
    overlap += x.filter((i) => y.includes(i)).length / 10
    if (x[0] === y[0]) same1++
    for (let r = 0; r < n; r++) maxError = Math.max(maxError, Math.abs(ranked[a][q]![r]! - ranked[b][q]![r]!))
  }
  return { top10Overlap: +(overlap / evals.length).toFixed(4), sameFirst: `${same1}/${evals.length}`, maxScoreError: +maxError.toExponential(2) }
}

const results = {
  model: MODEL.split("/").pop(),
  queries: evals.length,
  passages: n,
  embedSeconds: +embedSeconds.toFixed(1),
  packedVsSingleWorstCosine: +packedWorst.toFixed(6),
  quality: { f32: quality("f32"), stored: quality("stored"), int8: quality("int8") },
  agreement: { storedVsF32: agreement("stored", "f32"), int8VsF32: agreement("int8", "f32"), int8VsStored: agreement("int8", "stored") },
}
if (args.get("json")) writeFileSync(args.get("json")!, JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))

let failed = false
if (results.agreement.storedVsF32.top10Overlap < MIN_OVERLAP) { log(`the stored vectors agree with full precision on ${results.agreement.storedVsF32.top10Overlap} of the top 10, below ${MIN_OVERLAP}`); failed = true }
if (packedWorst < 0.999) { log(`packing passages together moved a vector to cosine ${packedWorst.toFixed(6)}, below 0.999`); failed = true }
process.exit(failed ? 1 : 0)
