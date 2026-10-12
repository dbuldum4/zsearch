/**
 * How long reading files for meaning takes: zsearch's semantic pass (src/semantic/indexer.ts)
 * against the way DigUp does it, on the same text, model, helper and machine.
 *
 *   bun scripts/bench-semantic/bench.ts --model=MODEL.gguf [--files=400] [--seed=7] [--work=DIR]
 *       [--only=first,edit,rebuild,tune,check] [--json=OUT]
 *
 * The baseline does what DigUp's indexer does (DigUp, MIT, github.com/ARahim3/DigUp at 6faa29e):
 * one file at a time, its text cut into 1,800-character passages overlapping by 200
 * (`DocExtractor.chunks`), the first 40 of each file and then the rest, sent to the model as they
 * come, up to 16 passages or 2,048 tokens a call (`LlamaEmbedder`), with no reuse between files
 * or runs. It reads the text zsearch already extracted, so extraction costs neither side anything,
 * and it leaves out code and data files, as DigUp does by default. Both run the same llama.cpp
 * helper (`zsearch-embed`, with `--no-sort --max-seqs 16` for the baseline).
 *
 * The corpus is scripts/bench.ts's generated home folder (prose, code, CSV, web pages and the
 * test documents), plus copies of some documents in Downloads, named as browsers name a second
 * download ("report (1).pdf"). `--model` may be the real EmbeddingGemma 2 file or the stand-in
 * that make-standin-model.py makes from the corpus (`--work` keeps the corpus for it).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join } from "node:path"
import { type Config, defaultConfig } from "../../src/config.ts"
import { clearIndex, decompressText, openDb } from "../../src/index/db.ts"
import { Indexer } from "../../src/index/indexer.ts"
import { documentPrompt, hasWords } from "../../src/semantic/chunk.ts"
import { Embedder, embedToolPath } from "../../src/semantic/helper.ts"
import { SemanticIndexer, type SemanticSummary } from "../../src/semantic/indexer.ts"
import { semanticDbPath } from "../../src/semantic/store.ts"
import { makeCorpus } from "../bench.ts"

const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k!, v ?? "true"] as [string, string] }))
const MODEL = args.get("model")
const FILES = Number(args.get("files") ?? 400)
const SEED = Number(args.get("seed") ?? 7)
const ONLY = new Set((args.get("only") ?? "first,edit,rebuild,tune,check").split(","))
const TOOL = args.get("tool") ?? embedToolPath()
/** Both sides run on all cores. */
const THREADS = Number(args.get("threads") ?? navigator.hardwareConcurrency)
if (!MODEL || !existsSync(MODEL) || !TOOL) {
  console.error("usage: bun scripts/bench-semantic/bench.ts --model=MODEL.gguf [--tool=dist/zsearch-embed] [--files=400] [--work=DIR]")
  process.exit(2)
}
process.env.ZSEARCH_MODELS = dirname(MODEL)

const work = args.get("work") ?? mkdtempSync(join(tmpdir(), "zsearch-semantic-bench-"))
const home = join(work, "home")
process.env.HOME = home
process.env.ZSEARCH_HOME = join(work, "data")
const dbPath = join(work, "data", "index.db")

const log = (s: string) => console.error(s)
const seconds = (ms: number) => +(ms / 1000).toFixed(1)

/* ------------------------------------------------------------ corpus -- */

if (!existsSync(home)) {
  const c = makeCorpus(home, FILES, SEED)
  // Second downloads of some documents, as browsers name them.
  let copies = 0
  const docs: string[] = []
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : /\.(md|txt|html|pdf|docx|pptx|xlsx|odt)$/.test(e.name) && docs.push(join(d, e.name)) }
  walk(join(home, "Documents"))
  for (let i = 0; i < docs.length; i += 12) {
    const src = docs[i]!
    const ext = extname(src)
    const to = join(home, "Downloads", `${basename(src, ext)} (1)${ext}`)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(src, to)
    copies++
  }
  log(`corpus: ${c.files} files + ${copies} copies, ${(c.bytes / 1e6).toFixed(1)} MB in ${home}`)
}
const config: Config = { ...defaultConfig(), roots: ["~/Documents", "~/Downloads"], semantic: { enabled: true, images: false, code: false } }

async function mainIndex(rebuild = false) {
  const db = openDb(dbPath)
  if (rebuild) clearIndex(db)
  const t = performance.now()
  const r = await new Indexer(db, config, { inProcess: true }).run()
  db.close()
  return { ms: performance.now() - t, files: r.added + r.updated }
}

/* ---------------------------------------------------------- baseline -- */

/** DigUp's `DocExtractor.chunks`: 1,800 characters, 200 of overlap, cut at a space. */
function digupChunks(text: string, size = 1800, overlap = 200, limit = 5001): string[] {
  const clean = text.replace(/[ \t ]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim()
  const out: string[] = []
  let start = 0
  while (start < clean.length && out.length < limit) {
    let end = Math.min(clean.length, start + size)
    if (end < clean.length) {
      const slice = clean.slice(start, end)
      const space = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\n"))
      if (space > size / 2) end = start + space
    }
    const chunk = clean.slice(start, end).trim()
    if (chunk) out.push(chunk)
    if (end >= clean.length) break
    let next = Math.max(start, end - overlap)
    if (next <= start) next = end
    while (next < end && !/\s/.test(clean[next]!)) next++
    start = next < end ? next : end
  }
  return out
}

/** The files DigUp reads for meaning (as zsearch's pass, which follows DigUp: no code or data). */
function baselineFiles(changedSince = 0): { id: number; name: string; mtime: number }[] {
  const db = openDb(dbPath)
  try {
    return db.query("SELECT id, name, mtime FROM files WHERE is_dir = 0 AND content_state = 1 AND content_len > 0 AND kind NOT IN ('code', 'data') AND seq > ? ORDER BY mtime DESC").all(changedSince) as { id: number; name: string; mtime: number }[]
  } finally { db.close() }
}

async function baseline(files: { id: number; name: string }[]) {
  const db = openDb(dbPath)
  const embedder = new Embedder({ tool: TOOL!, model: MODEL!, threads: THREADS, extra: ["--no-sort", "--max-seqs", "16", "--batch-tokens", "2048"] })
  await embedder.info()
  const t = performance.now()
  let passages = 0
  let tokens = 0
  const read = db.query("SELECT data FROM content WHERE id = ?")
  const texts = new Map<number, string[]>()
  // Round one: each file's first 40 passages; round two: the rest.
  for (const [from, to] of [[0, 40], [40, Infinity]] as const) {
    for (const f of files) {
      let chunks = texts.get(f.id)
      if (!chunks) {
        const row = read.get(f.id) as { data: Uint8Array } | null
        chunks = row ? digupChunks(decompressText(row.data)) : []
        texts.set(f.id, chunks)
      }
      const title = f.name.replace(/\.[^.]+$/, "")
      const prompts = chunks.slice(from, to).filter(hasWords).map((c) => documentPrompt(title, c))
      if (!prompts.length) continue
      const r = await embedder.embedTexts(prompts)
      passages += prompts.length
      tokens += r.tokens
    }
  }
  const ms = performance.now() - t
  embedder.close()
  db.close()
  return { ms, passages, tokens, files: files.length }
}

/* -------------------------------------------------------------- ours -- */

async function ours(extra: string[] = []): Promise<SemanticSummary & { ms: number }> {
  const db = openDb(dbPath)
  const t = performance.now()
  const r = await new SemanticIndexer(db, config, TOOL, {
    vectorVersion: 1,
    low: false,
    embedder: (o) => new Embedder({ ...o, threads: THREADS, tool: TOOL!, model: MODEL!, extra }),
  }).run()
  const ms = performance.now() - t
  db.close()
  if (r.status !== "done") throw new Error(`semantic pass: ${r.status} ${r.error ?? ""}`)
  return { ...r, ms }
}

function resetSemantic() {
  for (const s of ["", "-wal", "-shm"]) rmSync(semanticDbPath(dbPath) + s, { force: true })
}

/** Edit some files as people do: a paragraph added in the middle of one in twenty prose files. */
function editFiles(): number {
  const files: string[] = []
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : /\.(md|txt)$/.test(e.name) && files.push(join(d, e.name)) }
  walk(join(home, "Documents"))
  files.sort()
  let n = 0
  for (let i = 0; i < files.length; i += 20) {
    const text = readFileSync(files[i]!, "utf8")
    const at = text.indexOf("\n\n", Math.floor(text.length / 2))
    const cut = at > 0 ? at : text.length
    writeFileSync(files[i]!, `${text.slice(0, cut)}\n\nAdded in review: the figures above were checked again on Tuesday and the totals still hold.${text.slice(cut)}`)
    n++
  }
  return n
}

/* --------------------------------------------------------------- run -- */

const results: Record<string, unknown> = { files: FILES, model: basename(MODEL), cpus: navigator.hardwareConcurrency }
const first = await mainIndex()
log(`main index: ${first.files} files in ${seconds(first.ms)} s`)

if (ONLY.has("check")) {
  // Packing passages of different files and lengths into one model call must not change them.
  const db = openDb(dbPath)
  const rows = db.query("SELECT f.name, c.data FROM files f JOIN content c ON c.id = f.id WHERE f.kind IN ('text', 'markdown') LIMIT 24").all() as { name: string; data: Uint8Array }[]
  db.close()
  const prompts = rows.flatMap((r) => digupChunks(decompressText(r.data)).slice(0, 3).map((c) => documentPrompt(r.name, c)))
  const packed = new Embedder({ tool: TOOL, model: MODEL, threads: THREADS })
  const single = new Embedder({ tool: TOOL, model: MODEL, threads: THREADS, extra: ["--no-sort", "--max-seqs", "1"] })
  const a = await packed.embedTexts(prompts)
  const b = await single.embedTexts(prompts)
  packed.close(); single.close()
  let worst = 1
  for (let i = 0; i < prompts.length; i++) {
    let dot = 0
    for (let d = 0; d < a.dim; d++) dot += a.vectors[i * a.dim + d]! * b.vectors[i * b.dim + d]!
    worst = Math.min(worst, dot)
  }
  results.check = { passages: prompts.length, worstCosine: +worst.toFixed(6) }
  log(`packed vs one at a time: ${prompts.length} passages, lowest cosine ${worst.toFixed(6)}`)
}

if (ONLY.has("tune")) {
  // Batch size and flash attention, on the first 60 files' passages.
  const db = openDb(dbPath)
  const rows = db.query("SELECT f.name, c.data FROM files f JOIN content c ON c.id = f.id WHERE f.kind IN ('text', 'markdown', 'web', 'pdf', 'doc') ORDER BY f.id LIMIT 60").all() as { name: string; data: Uint8Array }[]
  db.close()
  const prompts = rows.flatMap((r) => digupChunks(decompressText(r.data)).filter(hasWords).map((c) => documentPrompt(r.name, c)))
  const tune: Record<string, number | string>[] = []
  // tokens:seqs:flash-attn:sorted|order[:max input], e.g. --tune=2048:16:auto:order,2048:64:auto:sorted
  const configs = (args.get("tune") ?? "2048:16:auto:order,2048:1:auto:order,2048:64:auto:sorted,1024:64:auto:sorted:1024,4096:64:auto:sorted,2048:64:off:sorted").split(",")
  for (const c of configs) {
    const [tokens, seqs, fa, order, maxInput] = c.split(":")
    const sort = order !== "order"
    const e = new Embedder({ tool: TOOL, model: MODEL, threads: THREADS, batchTokens: Number(tokens), maxSeqs: Number(seqs), extra: ["--flash-attn", fa!, ...(sort ? [] : ["--no-sort"]), ...(maxInput ? ["--max-input", maxInput] : [])] })
    await e.info()
    const t = performance.now()
    let used = 0
    for (let i = 0; i < prompts.length; i += 256) used += (await e.embedTexts(prompts.slice(i, i + 256))).tokens
    const ms = performance.now() - t
    e.close()
    tune.push({ config: c, passages: prompts.length, tokens: used, seconds: seconds(ms) })
    log(`tune ${c}: ${seconds(ms)} s for ${prompts.length} passages (${used} tokens)`)
  }
  results.tune = tune
}

if (ONLY.has("first")) {
  const files = baselineFiles()
  const b = await baseline(files)
  log(`DigUp-style first index: ${b.files} files, ${b.passages} passages, ${b.tokens} tokens in ${seconds(b.ms)} s`)
  resetSemantic()
  const o = await ours()
  log(`zsearch first index: ${o.files} files, ${o.embedded} embedded + ${o.reused} reused, ${o.tokens} tokens in ${seconds(o.ms)} s`)
  results.first = { digup: { ...b, seconds: seconds(b.ms) }, zsearch: { files: o.files, embedded: o.embedded, reused: o.reused, tokens: o.tokens, seconds: seconds(o.ms) } }
}

if (ONLY.has("edit")) {
  if (!ONLY.has("first")) { resetSemantic(); await ours() }
  const db = openDb(dbPath)
  const seq = Number((db.query("SELECT value FROM meta WHERE key = 'change_seq'").get() as { value: string } | null)?.value ?? 0)
  db.close()
  const edited = editFiles()
  await mainIndex()
  const changed = baselineFiles(seq)
  const b = await baseline(changed)
  log(`DigUp-style after editing ${edited} files: ${b.files} files, ${b.passages} passages in ${seconds(b.ms)} s`)
  const o = await ours()
  log(`zsearch after editing ${edited} files: ${o.embedded} embedded + ${o.reused} reused in ${seconds(o.ms)} s`)
  results.edit = { edited, digup: { ...b, seconds: seconds(b.ms) }, zsearch: { embedded: o.embedded, reused: o.reused, tokens: o.tokens, seconds: seconds(o.ms) } }
}

if (ONLY.has("rebuild")) {
  // A rebuilt index (new file ids): DigUp embeds everything again, as on the first run.
  await mainIndex(true)
  const o = await ours()
  log(`zsearch after a rebuild: ${o.embedded} embedded + ${o.reused} reused in ${seconds(o.ms)} s`)
  results.rebuild = { zsearch: { embedded: o.embedded, reused: o.reused, seconds: seconds(o.ms) } }
}

if (args.get("json")) writeFileSync(args.get("json")!, JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
if (!args.get("work")) rmSync(work, { recursive: true, force: true })
