#!/usr/bin/env bun
/**
 * Benchmark indexing and search on a generated corpus.
 *
 *   bun run bench                          # 20,000 files
 *   bun run bench --files=5000 --reps=5
 *   bun run bench --json=out.json          # also write the results as JSON
 *   bun run bench --compare=base.json      # show the change against an earlier run
 *   bun run bench --keep                   # keep the corpus and index (path is printed)
 *
 * The corpus is the same for the same --files and --seed: a home folder with Documents and
 * Downloads holding prose, code, data files, office documents from test/fixtures and binaries,
 * with a few planted words and patterns for the searches to find.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { defaultConfig } from "../src/config.ts"
import { openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine } from "../src/search/engine.ts"
import type { Mode } from "../src/search/query.ts"

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=")
    return [k!, v ?? "true"] as const
  }),
)
const FILES = Number(args.get("files") ?? 20_000)
const SEED = Number(args.get("seed") ?? 1)
const REPS = Number(args.get("reps") ?? 7)

/* ------------------------------------------------------------- corpus -- */

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const COMMON = `the of and to in is that for it as was with be by on not he this are or his from at which but have an they you were
their one all we can her has there been if more when will would who so no she other its may these about some time two into than
only could new any people also first then most over such out like made after many year years work report data file plan team
project budget meeting notes review draft final version update summary invoice order account client service product market
sales revenue cost price quarter month week date total number value result analysis research design test system user page`.split(/\s+/)

function makeWords(rand: () => number, n: number): string[] {
  const on = ["b", "c", "d", "f", "g", "k", "l", "m", "n", "p", "r", "s", "t", "v", "z", "br", "st", "tr", "pl", "gr", "sh", "ch"]
  const nu = ["a", "e", "i", "o", "u", "ai", "ea", "io", "ou"]
  const co = ["", "n", "r", "s", "t", "l", "m", "nd", "st", "rt", "ck"]
  const out = new Set<string>()
  while (out.size < n) {
    let w = ""
    const syl = 1 + Math.floor(rand() * 3)
    for (let i = 0; i < syl; i++) w += on[Math.floor(rand() * on.length)]! + nu[Math.floor(rand() * nu.length)]! + co[Math.floor(rand() * co.length)]!
    if (w.length >= 3) out.add(w)
  }
  return [...out]
}

/** Zipf-distributed word picker. */
function zipf(words: string[], rand: () => number) {
  const cum: number[] = []
  let total = 0
  for (let i = 0; i < words.length; i++) cum.push((total += 1 / Math.pow(i + 1, 1.05)))
  return () => {
    const x = rand() * total
    let lo = 0
    let hi = cum.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid]! < x) lo = mid + 1
      else hi = mid
    }
    return words[lo]!
  }
}

const NEEDLE = "zanzibarite"
const PHRASE = "quarterly revenue forecast"

export function makeCorpus(root: string, files: number, seed: number): { files: number; bytes: number } {
  const rand = rng(seed)
  const words = [...COMMON, ...makeWords(rand, 12_000)]
  const word = zipf(words, rand)
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!
  const sentence = () => {
    const n = 6 + Math.floor(rand() * 14)
    const ws = Array.from({ length: n }, word)
    ws[0] = ws[0]![0]!.toUpperCase() + ws[0]!.slice(1)
    return ws.join(" ") + pick([".", ".", ".", "?", "!"])
  }
  const size = () => Math.min(200_000, Math.round(Math.exp(Math.log(2500) + 1.1 * gauss())))
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand())

  const fixtures = join(import.meta.dir, "..", "test", "fixtures", "docs")
  const docs = readdirSync(fixtures).map((f) => join(fixtures, f))

  // Folder tree: Documents and Downloads, projects, nested topic folders.
  const dirs: string[] = []
  const nDirs = Math.max(8, Math.round(files / 25))
  for (let i = 0; i < nDirs; i++) {
    const top = rand() < 0.75 ? "Documents" : "Downloads"
    const depth = 1 + Math.floor(rand() * 4)
    const parts = [top]
    for (let d = 0; d < depth; d++) parts.push(rand() < 0.3 ? `${word()}-${2015 + Math.floor(rand() * 11)}` : word())
    dirs.push(parts.join("/"))
  }

  let bytes = 0
  const write = (rel: string, data: string | Uint8Array) => {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, data)
    bytes += typeof data === "string" ? Buffer.byteLength(data) : data.length
  }

  for (let i = 0; i < files; i++) {
    const dir = pick(dirs)
    const base = `${word()}${rand() < 0.5 ? "_" + word() : ""}${rand() < 0.3 ? "-" + (i % 97) : ""}`
    const r = rand()
    const plant = (text: string) => {
      if (i % 997 === 0) text += `\nThe ${NEEDLE} sample was logged.\n`
      if (i % 101 === 0) text += `\nSee the ${PHRASE} for details.\n`
      if (i % 53 === 0) text += `\nInvoice INV-${1000 + (i % 9000)} dated 2024-0${1 + (i % 9)}-1${i % 10}.\n`
      return text
    }
    if (r < 0.35) {
      let t = ""
      const target = size()
      while (t.length < target) t += (rand() < 0.15 ? `\n## ${sentence()}\n\n` : "") + sentence() + (rand() < 0.2 ? "\n\n" : " ")
      write(`${dir}/${base}.${pick(["md", "txt", "txt", "md"])}`, plant(t))
    } else if (r < 0.6) {
      let t = ""
      const target = size()
      const id = () => word() + word()[0]!.toUpperCase() + word().slice(1)
      while (t.length < target) {
        t += pick([
          `function ${id()}(${id()}, ${id()}) {\n  return ${id()} + ${Math.floor(rand() * 1000)}\n}\n`,
          `const ${id()} = "${sentence()}"\n`,
          `// ${sentence()}\n`,
          `if (${id()} > ${Math.floor(rand() * 100)}) { ${id()}.${id()}() }\n`,
        ])
      }
      write(`${dir}/${base}.${pick(["ts", "py", "go", "js", "rs"])}`, plant(t))
    } else if (r < 0.7) {
      const rows = 5 + Math.floor(size() / 60)
      const lines = ["id,name,amount,date,note"]
      for (let k = 0; k < rows; k++) lines.push(`${k},${word()},${(rand() * 1000).toFixed(2)},2023-${String(1 + (k % 12)).padStart(2, "0")}-${String(1 + (k % 28)).padStart(2, "0")},${word()} ${word()}`)
      write(`${dir}/${base}.csv`, plant(lines.join("\n")))
    } else if (r < 0.75) {
      write(`${dir}/${base}.html`, plant(`<html><head><title>${sentence()}</title></head><body><p>${Array.from({ length: 1 + Math.floor(size() / 200) }, sentence).join("</p><p>")}</p></body></html>`))
    } else if (r < 0.8) {
      const src = pick(docs)
      const p = join(root, dir, `${base}${src.slice(src.lastIndexOf("."))}`)
      mkdirSync(dirname(p), { recursive: true })
      copyFileSync(src, p)
      bytes += statSync(p).size
    } else {
      const n = 256 + Math.floor(rand() * 4096)
      const data = new Uint8Array(n)
      for (let k = 0; k < n; k++) data[k] = Math.floor(rand() * 256)
      write(`${dir}/${base}.${pick(["jpg", "png", "zip", "bin", "mp3"])}`, data)
    }
  }
  return { files, bytes }
}

/* -------------------------------------------------------------- bench -- */

interface QueryResult {
  name: string
  query: string
  mode: Mode
  hits: number
  /** First run: nothing cached by the engine yet. */
  cold: number
  p50: number
  max: number
}

export interface BenchResult {
  files: number
  corpusMB: number
  indexSeconds: number
  reindexSeconds: number
  dbMB: number
  tables: Record<string, number>
  queries: QueryResult[]
  typingMsPerKey: Record<string, number>
  previewMs: number
}

const QUERIES: { name: string; query: string; mode: Mode }[] = [
  { name: "recent files (empty query)", query: "", mode: "find" },
  { name: "find: common word", query: "the", mode: "find" },
  { name: "find: medium word", query: "budget", mode: "find" },
  { name: "find: rare word", query: NEEDLE, mode: "find" },
  { name: "find: phrase", query: PHRASE, mode: "find" },
  { name: "find: part of a word", query: "quart", mode: "find" },
  { name: "find: regex with a literal", query: "/INV-\\d{4}/", mode: "find" },
  { name: "find: regex without a literal", query: "/\\d{4}-0\\d-1\\d/", mode: "find" },
  { name: "find: filter only", query: "ext:pdf", mode: "find" },
  { name: "find: word + filters", query: "report type:code", mode: "find" },
  { name: "fuzzy: name", query: "rprt", mode: "fuzzy" },
  { name: "fuzzy: two words", query: "budget notes", mode: "fuzzy" },
  { name: "fuzzy: typo", query: "invoyce", mode: "fuzzy" },
]

const TYPING: { name: string; query: string; mode: Mode }[] = [
  { name: "find: type 'forecast'", query: "forecast", mode: "find" },
  { name: "fuzzy: type 'budgetnotes'", query: "budgetnotes", mode: "fuzzy" },
]

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  return { p50: s[Math.floor(s.length / 2)]!, max: s[s.length - 1]! }
}

async function bench(): Promise<BenchResult> {
  const keep = args.get("keep") === "true"
  const work = mkdtempSync(join(process.env.ZSEARCH_BENCH_TMP || tmpdir(), "zsearch-bench-"))
  const home = join(work, "home")
  process.env.HOME = home
  process.env.ZSEARCH_HOME = join(work, "data")
  const dbPath = join(work, "data", "index.db")
  try {
    let t = performance.now()
    const corpus = makeCorpus(home, FILES, SEED)
    console.error(`corpus: ${FILES.toLocaleString()} files, ${(corpus.bytes / 1e6).toFixed(1)} MB in ${((performance.now() - t) / 1000).toFixed(1)}s (${work})`)

    const config = { ...defaultConfig(), roots: [join(home, "Documents"), join(home, "Downloads")] }
    let db = openDb(dbPath)
    t = performance.now()
    const first = await new Indexer(db, config).run()
    const indexSeconds = (performance.now() - t) / 1000
    if (first.phase !== "done") throw new Error(`indexing ended with ${first.phase}: ${first.error ?? ""}`)
    t = performance.now()
    await new Indexer(db, config).run()
    const reindexSeconds = (performance.now() - t) / 1000
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    const tables: Record<string, number> = {}
    for (const r of db.query("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC").all() as { name: string; bytes: number }[]) {
      tables[r.name] = +(r.bytes / 1e6).toFixed(2)
    }
    db.close()
    const dbMB = +(statSync(dbPath).size / 1e6).toFixed(2)
    console.error(`index: ${indexSeconds.toFixed(1)}s, re-index ${reindexSeconds.toFixed(2)}s, ${dbMB} MB`)

    db = openDb(dbPath)
    const engine = new SearchEngine(db, config)
    const queries: QueryResult[] = []
    for (const q of QUERIES) {
      const times: number[] = []
      let hits = 0
      let cold = 0
      for (let i = 0; i <= REPS; i++) {
        const s = performance.now()
        const res = await engine.search(q.query, q.mode, { limit: 200 })
        if (res.error) throw new Error(`${q.name}: ${res.error}`)
        if (i === 0) cold = performance.now() - s
        else times.push(performance.now() - s)
        hits = res.total
      }
      queries.push({ ...q, hits, cold, ...stats(times) })
    }
    const typingMsPerKey: Record<string, number> = {}
    for (const q of TYPING) {
      const perKey: number[] = []
      for (let rep = 0; rep < REPS; rep++) {
        const s = performance.now()
        for (let k = 1; k <= q.query.length; k++) await engine.search(q.query.slice(0, k), q.mode, { limit: 200 })
        perKey.push((performance.now() - s) / q.query.length)
      }
      typingMsPerKey[q.name] = +stats(perKey).p50.toFixed(2)
    }
    const top = (await engine.search("budget", "find", { limit: 20 })).hits.filter((h) => !h.isDir)
    const pv: number[] = []
    for (let rep = 0; rep < REPS; rep++) {
      for (const h of top) {
        const s = performance.now()
        engine.preview(h.id, "budget", "find")
        pv.push(performance.now() - s)
      }
    }
    db.close()
    return {
      files: FILES,
      corpusMB: +(corpus.bytes / 1e6).toFixed(1),
      indexSeconds: +indexSeconds.toFixed(2),
      reindexSeconds: +reindexSeconds.toFixed(2),
      dbMB,
      tables,
      queries: queries.map((q) => ({ ...q, cold: +q.cold.toFixed(2), p50: +q.p50.toFixed(2), max: +q.max.toFixed(2) })),
      typingMsPerKey,
      previewMs: +stats(pv).p50.toFixed(2),
    }
  } finally {
    if (keep) console.error(`kept ${work}`)
    else rmSync(work, { recursive: true, force: true })
  }
}

function delta(now: number, before: number | undefined): string {
  if (before === undefined || before === 0) return ""
  const pct = ((now - before) / before) * 100
  return ` (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)`
}

function report(r: BenchResult, base?: BenchResult): string {
  const out: string[] = []
  out.push(`### zsearch benchmark: ${r.files.toLocaleString("en-US")} files, ${r.corpusMB} MB`)
  out.push("")
  out.push("| Index | |")
  out.push("|---|---:|")
  out.push(`| full index | ${r.indexSeconds} s${delta(r.indexSeconds, base?.indexSeconds)} |`)
  out.push(`| re-index, nothing changed | ${r.reindexSeconds} s${delta(r.reindexSeconds, base?.reindexSeconds)} |`)
  out.push(`| database size | ${r.dbMB} MB${delta(r.dbMB, base?.dbMB)} |`)
  for (const [t, mb] of Object.entries(r.tables).slice(0, 8)) out.push(`| &nbsp;&nbsp;${t} | ${mb} MB${delta(mb, base?.tables[t])} |`)
  out.push("")
  out.push("| Search | hits | first run ms | median ms | max ms |")
  out.push("|---|---:|---:|---:|---:|")
  for (const q of r.queries) {
    const b = base?.queries.find((x) => x.name === q.name)
    out.push(`| ${q.name} \`${q.query || "∅"}\` | ${q.hits} | ${q.cold ?? ""}${delta(q.cold, b?.cold)} | ${q.p50}${delta(q.p50, b?.p50)} | ${q.max} |`)
  }
  for (const [name, ms] of Object.entries(r.typingMsPerKey)) out.push(`| ${name}, per keystroke | | | ${ms}${delta(ms, base?.typingMsPerKey[name])} | |`)
  out.push(`| preview | | | ${r.previewMs}${delta(r.previewMs, base?.previewMs)} | |`)
  return out.join("\n")
}

if (import.meta.main) {
  const result = await bench()
  const base = args.has("compare") ? (JSON.parse(readFileSync(args.get("compare")!, "utf8")) as BenchResult) : undefined
  console.log(report(result, base))
  if (args.has("json")) writeFileSync(args.get("json")!, JSON.stringify(result, null, 2) + "\n")
}
