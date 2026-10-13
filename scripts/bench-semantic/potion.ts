/**
 * How fast Potion's pass reads a home folder: passages a second for a first run from scratch.
 *
 *   bun scripts/bench-semantic/potion.ts [--files=20000] [--seed=3] [--work=DIR] [--model=DIR] [--runs=2]
 *       [--index-load=70] [--json=OUT]
 *
 * The corpus is scripts/bench.ts's generated home folder with code included (`semantic.code`),
 * indexed once by the main indexer; only the Potion pass is timed, each run from an empty
 * semantic index. `--model` is a folder with the real potion-retrieval-32M files; without it a
 * stand-in of the same shape is made (a WordPiece vocabulary of the corpus's words and their
 * pieces, padded to 63,091 entries, and a random 512-wide table of 32-bit floats). Its vectors
 * mean nothing, but it costs what the real model costs to run.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Config, defaultConfig } from "../../src/config.ts"
import { decompressText, openDb } from "../../src/index/db.ts"
import { Indexer } from "../../src/index/indexer.ts"
import { SemanticIndexer } from "../../src/semantic/indexer.ts"
import { preTokenize, normalize } from "../../src/semantic/potion.ts"
import { semanticDbPath } from "../../src/semantic/store.ts"
import { makeCorpus } from "../bench.ts"

const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k!, v ?? "true"] as [string, string] }))
const FILES = Number(args.get("files") ?? 20_000)
const SEED = Number(args.get("seed") ?? 3)
const RUNS = Number(args.get("runs") ?? 2)
const work = args.get("work") ?? mkdtempSync(join(tmpdir(), "zsearch-potion-bench-"))
const home = join(work, "home")
process.env.HOME = home
process.env.ZSEARCH_HOME = join(work, "data")
const dbPath = join(work, "data", "index.db")
const log = (s: string) => console.error(s)

const config: Config = { ...defaultConfig(), ...(args.has("index-load") ? { indexLoad: Number(args.get("index-load")) } : {}), roots: ["~/Documents", "~/Downloads"], semantic: { enabled: false, declined: false, code: true } }

if (!existsSync(home)) {
  const c = makeCorpus(home, FILES, SEED)
  log(`corpus: ${c.files} files, ${(c.bytes / 1e6).toFixed(1)} MB in ${home}`)
}
if (!existsSync(dbPath)) {
  const db = openDb(dbPath)
  const t = performance.now()
  const r = await new Indexer(db, config, { inProcess: true }).run()
  db.close()
  log(`main index: ${r.added + r.updated} files in ${((performance.now() - t) / 1000).toFixed(1)} s`)
}

/* ------------------------------------------------------- stand-in model -- */

const VOCAB = 63_091
const DIM = 512

function makeStandin(dir: string) {
  mkdirSync(dir, { recursive: true })
  const db = openDb(dbPath)
  const counts = new Map<string, number>()
  let seen = 0
  for (const r of db.query("SELECT data FROM content LIMIT 3000").all() as { data: Uint8Array }[]) {
    const text = decompressText(r.data).slice(0, 50_000)
    for (const w of preTokenize(normalize(text))) counts.set(w, (counts.get(w) ?? 0) + 1)
    if ((seen += text.length) > 30e6) break
  }
  db.close()
  const vocab: Record<string, number> = {}
  let id = 0
  const add = (p: string) => { if (!(p in vocab)) vocab[p] = id++ }
  for (const s of ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"]) add(s)
  for (let c = 33; c < 127; c++) { add(String.fromCharCode(c).toLowerCase()); add("##" + String.fromCharCode(c).toLowerCase()) }
  // Like BERT's: the common words whole, the rest in pieces of two to four letters.
  const words = [...counts].sort((a, b) => b[1] - a[1]).map(([w]) => w)
  for (const w of words.slice(0, 8000)) add(w)
  for (const w of words) {
    for (let i = 1; i + 2 <= w.length && id < VOCAB; i += 2) add("##" + w.slice(i, i + 2 + (i % 3 === 0 ? 1 : 0)))
    if (id >= VOCAB) break
  }
  for (const w of words.slice(8000)) if (id < VOCAB) add(w)
  while (id < VOCAB) add(`[unused${id}]`)
  writeFileSync(join(dir, "tokenizer.json"), JSON.stringify({ model: { type: "WordPiece", vocab, continuing_subword_prefix: "##" } }))
  const header = JSON.stringify({ embeddings: { dtype: "F32", shape: [VOCAB, DIM], data_offsets: [0, VOCAB * DIM * 4] } })
  const pad = (8 - (header.length % 8)) % 8
  const h = header + " ".repeat(pad)
  const out = new Uint8Array(8 + h.length + VOCAB * DIM * 4)
  new DataView(out.buffer).setBigUint64(0, BigInt(h.length), true)
  out.set(new TextEncoder().encode(h), 8)
  const table = new Float32Array(out.buffer, 8 + h.length, VOCAB * DIM)
  let s = 7
  for (let i = 0; i < table.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; table[i] = (s / 2 ** 32 - 0.5) * 0.1 }
  writeFileSync(join(dir, "model.safetensors"), out)
  log(`stand-in model: ${Object.keys(vocab).length} pieces x ${DIM} in ${dir}`)
}

const modelDir = args.get("model") ?? join(work, "potion-standin")
if (!existsSync(join(modelDir, "model.safetensors"))) makeStandin(modelDir)
process.env.ZSEARCH_MODELS = modelDir

/* ---------------------------------------------------------------- run -- */

const results: { seconds: number; passages: number; perSecond: number; files: number }[] = []
for (let i = 0; i < RUNS; i++) {
  for (const s of ["", "-wal", "-shm"]) rmSync(semanticDbPath(dbPath, "fast") + s, { force: true })
  const db = openDb(dbPath)
  const t = performance.now()
  const r = await new SemanticIndexer(db, config, null, { tier: "fast", low: false }).run()
  const seconds = (performance.now() - t) / 1000
  db.close()
  if (r.status !== "done") throw new Error(`Potion pass: ${r.status} ${r.error ?? ""}`)
  const passages = r.embedded + r.reused
  results.push({ seconds: +seconds.toFixed(2), passages, perSecond: Math.round(passages / seconds), files: r.files })
  log(`run ${i + 1}: ${r.files} files, ${r.embedded} passages embedded + ${r.reused} reused in ${seconds.toFixed(1)} s: ${Math.round(passages / seconds)} passages/s`)
}
if (args.has("json")) writeFileSync(args.get("json")!, JSON.stringify(results, null, 2))
