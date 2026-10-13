/** Manual runtime comparison: identical model, prompts and tokens; no extraction or cache reuse. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { Embedder } from "../../src/semantic/helper.ts"
import { downloadModel } from "../../src/semantic/model.ts"
import { chunkText, documentPrompt, queryPrompt } from "../../src/semantic/chunk.ts"

const args = new Map(process.argv.slice(2).map(a => { const i=a.indexOf("="); return [a.slice(2,i),a.slice(i+1)] }))
const baselineTool = args.get("baseline") ?? "work/baseline/zsearch-embed"
const currentTool = args.get("tool") ?? "dist/zsearch-embed"
const model = args.get("model") ?? (await downloadModel({ media: false, dir: "work/models" })).text!
const rounds = Number(args.get("rounds") ?? 1)
mkdirSync("work", {recursive:true})
const evals = JSON.parse(readFileSync("scripts/bench-semantic/evals.json", "utf8")).items as { title: string; text: string; query: string }[]
const docs = evals.map(e => documentPrompt(e.title, e.text))
for (const path of ["README.md", "macos/README.md"]) {
  for (const c of chunkText(readFileSync(path, "utf8"))) docs.push(documentPrompt(path, c.text))
}
const prompts = docs.slice(0, 96)
const queries = evals.map(e => queryPrompt(e.query))
const variants: [string, string[], boolean, string][] = [
  ["baseline", [], true, baselineTool],
  ["arm-split", [], false, currentTool],
  ["arm-dense", [], true, currentTool],
  ["arm-split-flash", ["--flash-attn", "on"], false, currentTool],
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
  const times: number[] = []
  let p = await helper.embedTexts(prompts)
  times.push((performance.now() - start) / 1000)
  for(let round=1;round<rounds;round++) {
    const t=performance.now(); p=await helper.embedTexts(prompts); times.push((performance.now()-t)/1000)
  }
  const seconds = [...times].sort((a,b)=>a-b)[Math.floor(times.length/2)]!
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
  const result = { name, seconds, times, tokens: p.tokens, passages: prompts.length, minCosine, meanCosine, overlap, at1 }
  results.push(result)
  console.log(JSON.stringify(result))
  writeFileSync("work/runtime.json", JSON.stringify({ platform:process.platform, arch:process.arch, results }, null, 2))
}
