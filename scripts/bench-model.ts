#!/usr/bin/env bun
/**
 * Granite alone on a BEIR-format set, without the rest of zsearch: how much of a gap between
 * `semantic-bench.ts` and MTEB's published scores comes from the runtime (the Q8_0 GGUF on
 * llama.cpp, against MTEB's full-precision model) and how much from cutting files into passages.
 *
 *   bun scripts/bench-model.ts --dataset=~/Library/Caches/zsearch-bench/scifact
 *   bun scripts/bench-model.ts --dataset=DIR --way=whole,passages --queries=300 --max-input=8192
 *
 * Ways (`--way`, default both):
 *   whole     each document embedded whole ("title text", up to --max-input tokens, as MTEB does)
 *   passages  each document cut as zsearch cuts it (chunk.ts), scored by its best passage
 * Both rank every document by cosine similarity, with no words, names or discounts.
 */
import { availableParallelism } from "node:os"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { chunkText, documentPrompt, queryPrompt } from "../src/semantic/chunk.ts"
import { Embedder, embedToolPath } from "../src/semantic/helper.ts"
import { GRANITE, installedModel } from "../src/semantic/model.ts"

const args = new Map(process.argv.slice(2).map((a) => { const i = a.indexOf("="); return i < 0 ? [a.replace(/^--/, ""), "true"] as const : [a.slice(2, i), a.slice(i + 1)] as const }))
const dataset = (args.get("dataset") ?? "").replace(/^~/, process.env.HOME ?? "~")
if (!dataset) throw new Error("--dataset=DIR is required")
const ways = (args.get("way") ?? "whole,passages").split(",")
const maxInput = Number(args.get("max-input") ?? 8192)
const maxQueries = Number(args.get("queries") ?? Infinity)
const tool = args.get("tool") ?? embedToolPath()
const model = installedModel(GRANITE)?.[0]
if (!tool || !model) throw new Error("Granite or its helper is not installed")

const readJsonl = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>)
const docs = readJsonl(join(dataset, "corpus.jsonl"))
const qrels = new Map<string, Map<string, number>>()
for (const line of readFileSync(join(dataset, "qrels", "test.tsv"), "utf8").split("\n").slice(1)) {
  const [q, d, s] = line.split("\t")
  if (!q || !d || !(Number(s) > 0)) continue
  if (!qrels.has(q)) qrels.set(q, new Map())
  qrels.get(q)!.set(d, Number(s))
}
const queries = readJsonl(join(dataset, "queries.jsonl")).filter((q) => qrels.has(q._id!)).slice(0, maxQueries)
const meta = existsSync(join(dataset, "meta.json")) ? JSON.parse(readFileSync(join(dataset, "meta.json"), "utf8")) as { reference?: { ndcg: number; recall: number } | null } : {}

function scores(ranked: string[], rel: Map<string, number>) {
  // Grades count as they are (no 2^g - 1), as BEIR's and MTEB's ndcg_cut has them.
  const dcg = ranked.slice(0, 10).reduce((s, d, i) => s + (rel.get(d) ?? 0) / Math.log2(i + 2), 0)
  const ideal = [...rel.values()].sort((a, b) => b - a).slice(0, 10).reduce((s, g, i) => s + g / Math.log2(i + 2), 0)
  const found = [...rel.keys()].filter((d) => ranked.slice(0, 100).includes(d)).length
  return { ndcg: ideal ? dcg / ideal : 0, recall: found / rel.size }
}

const embedder = new Embedder({ tool, model, pooling: "cls", threads: Math.min(4, availableParallelism()), batchTokens: maxInput, maxSeqs: 16, extra: ["--max-input", String(maxInput)] })
async function embed(texts: string[]): Promise<{ vectors: Float32Array; dim: number }> {
  const out: Float32Array[] = []
  let dim = 0
  // Bounded requests, so a large set never sits in one message.
  for (let i = 0; i < texts.length; i += 256) {
    const r = await embedder.embedTexts(texts.slice(i, i + 256))
    out.push(r.vectors)
    dim = r.dim
  }
  const vectors = new Float32Array(out.reduce((n, v) => n + v.length, 0))
  let at = 0
  for (const v of out) { vectors.set(v, at); at += v.length }
  return { vectors, dim }
}

try {
  const t0 = performance.now()
  const q = await embed(queries.map((x) => queryPrompt(x.text!)))
  console.error(`${dataset}: ${docs.length} documents, ${queries.length} queries`)
  for (const way of ways) {
    const t = performance.now()
    const owner: number[] = []
    const texts: string[] = []
    docs.forEach((d, i) => {
      if (way === "whole") { texts.push(`${d.title ?? ""} ${d.text ?? ""}`.trim()); owner.push(i); return }
      for (const c of chunkText(d.text ?? "")) { texts.push(documentPrompt(d.title ?? "", c.text)); owner.push(i) }
    })
    const v = await embed(texts)
    const sum = { ndcg: 0, recall: 0 }
    const best = new Float32Array(docs.length)
    for (let qi = 0; qi < queries.length; qi++) {
      best.fill(-Infinity)
      for (let r = 0; r < texts.length; r++) {
        let s = 0
        for (let k = 0; k < v.dim; k++) s += v.vectors[r * v.dim + k]! * q.vectors[qi * q.dim + k]!
        if (s > best[owner[r]!]!) best[owner[r]!] = s
      }
      const id = queries[qi]!._id!
      const order = Array.from(docs.keys()).filter((i) => docs[i]!._id !== id).sort((a, b) => best[b]! - best[a]!).slice(0, 100).map((i) => docs[i]!._id!)
      const s = scores(order, qrels.get(id)!)
      sum.ndcg += s.ndcg; sum.recall += s.recall
    }
    const n = Math.max(queries.length, 1)
    console.log(`${way.padEnd(9)} ${String(texts.length).padStart(7)} inputs  nDCG@10 ${(sum.ndcg / n).toFixed(3)}  R@100 ${(sum.recall / n).toFixed(3)}  ${((performance.now() - t) / 1000).toFixed(0)} s`)
  }
  if (meta.reference) console.log(`MTEB      published         nDCG@10 ${meta.reference.ndcg.toFixed(3)}  R@100 ${meta.reference.recall.toFixed(3)}`)
  console.error(`${((performance.now() - t0) / 1000).toFixed(0)} s`)
} finally {
  embedder.close()
}
