/** Manual runtime comparison: identical model, prompts and tokens; no extraction or cache reuse. */
import { readFileSync, writeFileSync } from "node:fs"
import { Embedder } from "../../src/semantic/helper.ts"
import { downloadModel } from "../../src/semantic/model.ts"
import { chunkText, documentPrompt, queryPrompt } from "../../src/semantic/chunk.ts"

const model = (await downloadModel({ media: false, dir: "work/models" })).text!
const evals = JSON.parse(readFileSync("scripts/bench-semantic/evals.json", "utf8")).items as { title: string; text: string; query: string }[]
const docs = evals.map(e => documentPrompt(e.title, e.text))
for (const path of ["README.md", "macos/README.md"]) {
  for (const c of chunkText(readFileSync(path, "utf8"))) docs.push(documentPrompt(path, c.text))
}
const prompts = docs.slice(0, 96)
const queries = evals.map(e => queryPrompt(e.query))
const variants: [string, string[], boolean, string][] = [
  ["baseline", [], true, "work/baseline/zsearch-embed"],
  ["arm-split", [], false, "dist/zsearch-embed"],
  ["arm-dense", [], true, "dist/zsearch-embed"],
  ["arm-split-flash", ["--flash-attn", "on"], false, "dist/zsearch-embed"],
]
const results: Record<string, unknown>[] = []
let reference: Float32Array | null = null
let referenceQueries: Float32Array | null = null
for (const [name, extra, dense, tool] of variants) {
  if (dense) process.env.ZSEARCH_EMBED_DENSE_ATTN = "1"
  else delete process.env.ZSEARCH_EMBED_DENSE_ATTN
  const helper = new Embedder({ tool, model, extra })
  await helper.info()
  await helper.embedTexts(prompts.slice(0, 2))
  const start = performance.now()
  const p = await helper.embedTexts(prompts)
  const seconds = (performance.now() - start) / 1000
  const q = await helper.embedTexts(queries)
  helper.close()
  reference ??= p.vectors
  referenceQueries ??= q.vectors
  let minCosine = 1, meanCosine = 0, overlap = 0, at1 = 0
  for (let i = 0; i < prompts.length; i++) {
    let dot = 0
    for (let d = 0; d < p.dim; d++) dot += reference[i*p.dim+d]! * p.vectors[i*p.dim+d]!
    minCosine = Math.min(minCosine, dot); meanCosine += dot / prompts.length
  }
  const top = (pv: Float32Array, qv: Float32Array, query: number) => prompts.map((_, i) => {
    let score = 0
    for (let d = 0; d < p.dim; d++) score += pv[i*p.dim+d]! * qv[query*p.dim+d]!
    return { i, score }
  }).sort((a,b) => b.score-a.score).slice(0,10).map(x=>x.i)
  for(let i = 0; i < queries.length; i++) {
    const a = top(reference, referenceQueries, i), b = top(p.vectors, q.vectors, i)
    overlap += b.filter(x=>a.includes(x)).length / (10*queries.length)
    at1 += a[0] === b[0] ? 1/queries.length : 0
  }
  const result = { name, seconds, tokens: p.tokens, passages: prompts.length, minCosine, meanCosine, overlap, at1 }
  results.push(result)
  console.log(JSON.stringify(result))
  writeFileSync("work/runtime.json", JSON.stringify({ platform:process.platform, arch:process.arch, results }, null, 2))
}
