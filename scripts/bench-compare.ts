#!/usr/bin/env bun
/**
 * Whether a difference in `semantic-bench.ts` results is real: paired bootstrap 95% intervals of
 * the per-query differences, and how many queries got better or worse.
 *
 *   bun scripts/bench-compare.ts tmp/bench/*.json                    # every pipeline against `current`
 *   bun scripts/bench-compare.ts a.json b.json --base=model          # against another pipeline
 *   bun scripts/bench-compare.ts after.json --against=before.json    # one run against an earlier one
 *
 * `--metric=ndcg|mrr|recall` (default ndcg). An interval that leaves out 0 is a difference this
 * many queries can show; one that holds 0 is not, however large the average looks.
 */
import { readFileSync } from "node:fs"
import { basename } from "node:path"

interface Run {
  dataset: string
  queries: number
  reference: { ndcg: number; recall: number } | null
  results: { stage: string; pipeline: string; ndcg: number; mrr: number; recall: number; empty: number }[]
  perQuery: Record<string, Record<string, [number, number, number]>>
}

const argv = process.argv.slice(2)
const opt = new Map(argv.filter((a) => a.startsWith("--")).map((a) => { const i = a.indexOf("="); return i < 0 ? [a.slice(2), "true"] : [a.slice(2, i), a.slice(i + 1)] }))
const files = argv.filter((a) => !a.startsWith("--"))
if (!files.length) throw new Error("give one or more result files from semantic-bench.ts --json")
const metric = ({ ndcg: 0, mrr: 1, recall: 2 } as const)[(opt.get("metric") ?? "ndcg") as "ndcg"]
if (metric === undefined) throw new Error("--metric must be ndcg, mrr or recall")
const base = opt.get("base") ?? "current"
const load = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Run
const name = (run: Run, path: string) => basename(run.dataset || path)

/** Mean of the differences, and a 95% interval from resampling the queries (seeded: the same every run). */
function paired(diffs: number[], rounds = 4000): { mean: number; low: number; high: number; better: number; worse: number } {
  const n = diffs.length
  const mean = diffs.reduce((a, b) => a + b, 0) / Math.max(n, 1)
  let s = 12345
  const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32)
  const means = new Float64Array(rounds)
  for (let r = 0; r < rounds; r++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)]!
    means[r] = sum / Math.max(n, 1)
  }
  means.sort()
  return { mean, low: means[Math.floor(rounds * 0.025)]!, high: means[Math.floor(rounds * 0.975)]!, better: diffs.filter((d) => d > 1e-9).length, worse: diffs.filter((d) => d < -1e-9).length }
}

const sign = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3)
const line = (label: string, p: ReturnType<typeof paired>, value: number) => {
  const real = p.low > 0 || p.high < 0 ? (p.mean > 0 ? "better" : "worse") : ""
  console.log(`  ${label.padEnd(16)} ${value.toFixed(3)}  ${sign(p.mean).padStart(7)}  [${sign(p.low)}, ${sign(p.high)}]  ${String(p.better).padStart(4)} up ${String(p.worse).padStart(4)} down  ${real}`)
}

if (opt.has("against")) {
  const before = load(opt.get("against")!)
  for (const path of files) {
    const after = load(path)
    console.log(`${name(after, path)}: ${path} against ${opt.get("against")}`)
    const ids = Object.keys(after.perQuery).filter((q) => before.perQuery[q])
    for (const row of after.results) {
      const diffs = ids.filter((q) => after.perQuery[q]![row.pipeline] && before.perQuery[q]![row.pipeline]).map((q) => after.perQuery[q]![row.pipeline]![metric] - before.perQuery[q]![row.pipeline]![metric])
      if (diffs.length) line(row.pipeline, paired(diffs), [row.ndcg, row.mrr, row.recall][metric]!)
    }
  }
} else {
  for (const path of files) {
    const run = load(path)
    const ref = run.reference ? `; MTEB, model alone: nDCG@10 ${run.reference.ndcg.toFixed(3)}` : ""
    console.log(`${name(run, path)} (${run.queries} queries${ref}), against ${base}:`)
    const ids = Object.keys(run.perQuery)
    for (const row of run.results) {
      const value = [row.ndcg, row.mrr, row.recall][metric]!
      if (row.pipeline === base) { console.log(`  ${row.pipeline.padEnd(16)} ${value.toFixed(3)}  (base)  empty ${(row.empty * 100).toFixed(1)}%`); continue }
      const diffs = ids.filter((q) => run.perQuery[q]![row.pipeline] && run.perQuery[q]![base]).map((q) => run.perQuery[q]![row.pipeline]![metric] - run.perQuery[q]![base]![metric])
      if (diffs.length) line(row.pipeline, paired(diffs), value)
    }
  }
}
