#!/usr/bin/env bun
/**
 * Downloads public retrieval benchmarks and writes each in BEIR's layout for `semantic-bench.ts`:
 * `corpus.jsonl` ({_id, title, text}), `queries.jsonl` ({_id, text}), `qrels/test.tsv`, and
 * `meta.json` (where it came from, the file extension its documents are saved with, and the score
 * MTEB published for Granite small on it, when there is one).
 *
 *   bun scripts/bench-data.ts --list
 *   bun scripts/bench-data.ts scifact nfcorpus lemb-qmsum enron-dasovich
 *   bun scripts/bench-data.ts nano            # all 13 NanoBEIR sets (needs `uv`, for Parquet)
 *
 * Data goes to `--dir` (default ~/Library/Caches/zsearch-bench on macOS, ~/.cache/zsearch-bench
 * elsewhere). Only the files a set needs are downloaded; NanoBEIR's Parquet originals are deleted
 * once converted. Sets already present are skipped. Nothing here is committed to the repository.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const HF = "https://huggingface.co/datasets"

/**
 * Granite small (granite-embedding-small-english-r2) in MTEB's published results
 * (github.com/embeddings-benchmark/results), nDCG@10 and recall@100: the model alone, each document
 * embedded whole (up to 8,192 tokens), ranked by cosine similarity.
 */
const MTEB: Record<string, { ndcg: number; recall: number; task: string }> = {
  scifact: { ndcg: 0.7549, recall: 0.98, task: "SciFact" },
  nfcorpus: { ndcg: 0.3714, recall: 0.347, task: "NFCorpus" },
  arguana: { ndcg: 0.544, recall: 0.9893, task: "ArguAna" },
  fiqa: { ndcg: 0.4081, recall: 0.735, task: "FiQA2018" },
  scidocs: { ndcg: 0.2406, recall: 0.534, task: "SCIDOCS" },
  "lemb-narrativeqa": { ndcg: 0.4132, recall: 0.8194, task: "LEMBNarrativeQARetrieval" },
  "lemb-qmsum": { ndcg: 0.3648, recall: 0.9561, task: "LEMBQMSumRetrieval" },
  "lemb-summscreenfd": { ndcg: 0.8991, recall: 1, task: "LEMBSummScreenFDRetrieval" },
  "lemb-2wikimqa": { ndcg: 0.7995, recall: 0.98, task: "LEMBWikimQARetrieval" },
  "lemb-needle-4096": { ndcg: 0.7788, recall: 1, task: "LEMBNeedleRetrieval (test_4096)" },
  "lemb-needle-16384": { ndcg: 0.4415, recall: 1, task: "LEMBNeedleRetrieval (test_16384)" },
  "lemb-needle-32768": { ndcg: 0.2194, recall: 1, task: "LEMBNeedleRetrieval (test_32768)" },
}

const BEIR = ["scifact", "nfcorpus", "arguana", "fiqa", "scidocs"]
const LEMB: Record<string, string> = { "lemb-qmsum": "qmsum", "lemb-summscreenfd": "summ_screen_fd", "lemb-2wikimqa": "2wikimqa", "lemb-narrativeqa": "narrativeqa" }
const NEEDLE = [4096, 16384, 32768]
const NANO = ["ArguAna", "ClimateFEVER", "DBPedia", "FEVER", "FiQA2018", "HotpotQA", "MSMARCO", "NFCorpus", "NQ", "QuoraRetrieval", "SCIDOCS", "SciFact", "Touche2020"]

const SETS: Record<string, string> = {
  ...Object.fromEntries(BEIR.map((n) => [n, `BEIR ${n} (mteb/${n})`])),
  ...Object.fromEntries(Object.entries(LEMB).map(([n, t]) => [n, `LongEmbed ${t} (dwzhu/LongEmbed)${t === "narrativeqa" ? ", 120 MB" : ""}`])),
  ...Object.fromEntries(NEEDLE.map((l) => [`lemb-needle-${l}`, `LongEmbed needle, ${l}-token haystacks`])),
  "enron-dasovich": "EnronQA, Jeff Dasovich's mailbox: 4,891 emails as .eml (weaviate/enron-qa-*-dasovich-j)",
  ...Object.fromEntries(NANO.map((n) => [`nano-${n.toLowerCase()}`, `NanoBEIR ${n} (zeta-alpha-ai/Nano${n})`])),
}

const args = process.argv.slice(2)
const opt = new Map(args.filter((a) => a.startsWith("--")).map((a) => { const i = a.indexOf("="); return i < 0 ? [a.slice(2), "true"] : [a.slice(2, i), a.slice(i + 1)] }))
const root = (opt.get("dir") ?? join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache", "zsearch-bench")).replace(/^~(?=\/|$)/, homedir())
if (opt.has("list") || !args.some((a) => !a.startsWith("--"))) {
  for (const [name, what] of Object.entries(SETS)) console.log(`${name.padEnd(22)} ${what}`)
  console.log(`\nnano = every NanoBEIR set, beir = ${BEIR.join(" ")}, lemb = qmsum summscreenfd 2wikimqa needle-*`)
  process.exit(0)
}
const wanted = args.filter((a) => !a.startsWith("--")).flatMap((a) =>
  a === "nano" ? NANO.map((n) => `nano-${n.toLowerCase()}`)
  : a === "beir" ? BEIR
  : a === "lemb" ? ["lemb-qmsum", "lemb-summscreenfd", "lemb-2wikimqa", ...NEEDLE.map((l) => `lemb-needle-${l}`)]
  : [a])
for (const name of wanted) if (!SETS[name]) throw new Error(`unknown set ${name}; --list shows them`)

async function get(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { redirect: "follow" })
    if (res.ok) return await res.text()
    if (attempt >= 3 || res.status < 500) throw new Error(`${url}: HTTP ${res.status}`)
    await Bun.sleep(1000 * 2 ** attempt)
  }
}

async function download(url: string, to: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  await Bun.write(to, res)
}

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
const readJsonl = (text: string) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
const tsv = (rows: [string, string, number][]) => "query-id\tcorpus-id\tscore\n" + rows.map((r) => r.join("\t")).join("\n") + "\n"

/** A fixed shuffle, so `--queries=N` in the benchmark takes the same sample everywhere. */
function shuffled<T>(items: T[], seed = 1): T[] {
  const out = items.slice()
  let s = seed
  const next = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

function write(dir: string, set: { corpus: object[]; queries: object[]; qrels: [string, string, number][]; meta: object }) {
  const tmp = `${dir}.part`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(join(tmp, "qrels"), { recursive: true })
  writeFileSync(join(tmp, "corpus.jsonl"), jsonl(set.corpus))
  writeFileSync(join(tmp, "queries.jsonl"), jsonl(set.queries))
  writeFileSync(join(tmp, "qrels", "test.tsv"), tsv(set.qrels))
  writeFileSync(join(tmp, "meta.json"), JSON.stringify(set.meta, null, 2) + "\n")
  renameSync(tmp, dir)
}

async function fetchSet(name: string, dir: string) {
  const reference = MTEB[name] ?? null
  if (BEIR.includes(name)) {
    const base = `${HF}/mteb/${name}/resolve/main`
    const tmp = `${dir}.part`
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(join(tmp, "qrels"), { recursive: true })
    await download(`${base}/corpus.jsonl`, join(tmp, "corpus.jsonl"))
    await download(`${base}/queries.jsonl`, join(tmp, "queries.jsonl"))
    await download(`${base}/qrels/test.tsv`, join(tmp, "qrels", "test.tsv"))
    writeFileSync(join(tmp, "meta.json"), JSON.stringify({ source: `${HF}/mteb/${name}`, ext: "txt", reference }, null, 2) + "\n")
    renameSync(tmp, dir)
    return
  }
  if (name in LEMB || name.startsWith("lemb-needle-")) {
    const task = LEMB[name] ?? "needle"
    const base = `${HF}/dwzhu/LongEmbed/resolve/main/${task}`
    const length = name.startsWith("lemb-needle-") ? Number(name.slice("lemb-needle-".length)) : null
    const inGroup = (id: string) => length === null || id.startsWith(`ctx${length}_`)
    const corpus = readJsonl(await get(`${base}/corpus.jsonl`)).filter((d) => inGroup(String(d.doc_id))).map((d) => ({ _id: String(d.doc_id), title: "", text: String(d.text) }))
    const queries = readJsonl(await get(`${base}/queries.jsonl`)).filter((q) => inGroup(String(q.qid))).map((q) => ({ _id: String(q.qid), text: String(q.text) }))
    const qrels = readJsonl(await get(`${base}/qrels.jsonl`)).filter((r) => inGroup(String(r.qid))).map((r) => [String(r.qid), String(r.doc_id), 1] as [string, string, number])
    // Named by id: LongEmbed has no titles, and its ids say nothing about the text.
    write(dir, { corpus, queries, qrels, meta: { source: `${HF}/dwzhu/LongEmbed (${task}${length ? `, ${length} tokens` : ""})`, ext: "txt", names: "id", reference } })
    return
  }
  if (name === "enron-dasovich") {
    const emails = JSON.parse(await get(`${HF}/weaviate/enron-qa-emails-dasovich-j/resolve/main/enron-emails-dasovich-j.json`)) as { dataset_id: number; email_body: string }[]
    const questions = JSON.parse(await get(`${HF}/weaviate/enron-qa-questions-dasovich-j/resolve/main/enron-questions-dasovich-j.json`)) as { dataset_id: number; question: string }[]
    // Each body starts with "Subject:", "Sender:", "Recipients:" and "File:" lines and a rule: saved
    // as the .eml a mail client would export, so the email extractor reads it.
    const corpus = emails.map((e) => {
      const [head, ...rest] = e.email_body.split(/\n=+\n/)
      const field = (key: string) => new RegExp(`^${key}: ?(.*)$`, "m").exec(head ?? "")?.[1]?.trim() ?? ""
      const to = field("Recipients").replace(/^\[|\]$/g, "").replace(/'/g, "")
      const subject = field("Subject")
      const text = `From: ${field("Sender")}\nTo: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${rest.join("\n").trim()}\n`
      return { _id: String(e.dataset_id), title: subject, text }
    })
    const all = shuffled(questions.map((q, i) => ({ _id: `q${i}`, text: q.question, doc: String(q.dataset_id) })))
    write(dir, {
      corpus,
      queries: all.map(({ _id, text }) => ({ _id, text })),
      qrels: all.map((q) => [q._id, q.doc, 1]),
      meta: { source: "EnronQA (arXiv:2505.00263), Jeff Dasovich's inbox, via huggingface.co/datasets/weaviate/enron-qa-emails-dasovich-j and -questions-dasovich-j", ext: "eml", queries: "shuffled with a fixed seed; take a sample with --queries=N", reference: null },
    })
    return
  }
  if (name.startsWith("nano-")) {
    const set = NANO.find((n) => `nano-${n.toLowerCase()}` === name)!
    const base = `${HF}/zeta-alpha-ai/Nano${set}/resolve/main`
    const tmp = `${dir}.parquet`
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    try {
      for (const part of ["corpus", "queries", "qrels"]) await download(`${base}/${part}/train-00000-of-00001.parquet`, join(tmp, `${part}.parquet`))
      const py = "import pyarrow.parquet as pq, json, sys\nfor p in ['corpus', 'queries', 'qrels']:\n  rows = pq.read_table(f'{sys.argv[1]}/{p}.parquet').to_pylist()\n  open(f'{sys.argv[1]}/{p}.jsonl', 'w').write(''.join(json.dumps(r) + '\\n' for r in rows))\n"
      const run = Bun.spawnSync(["uv", "run", "--quiet", "--with", "pyarrow", "python", "-c", py, tmp], { stderr: "pipe" })
      if (run.exitCode !== 0) throw new Error(`converting ${name} needs uv (https://docs.astral.sh/uv): ${run.stderr.toString()}`)
      const read = (p: string) => readJsonl(readFileSync(join(tmp, `${p}.jsonl`), "utf8"))
      write(dir, {
        corpus: read("corpus").map((d) => ({ _id: String(d._id), title: String(d.title ?? ""), text: String(d.text ?? "") })),
        queries: read("queries").map((q) => ({ _id: String(q._id), text: String(q.text) })),
        qrels: read("qrels").map((r) => [String(r["query-id"]), String(r["corpus-id"]), Number(r.score ?? 1)]),
        meta: { source: `${HF}/zeta-alpha-ai/Nano${set}`, ext: "txt", reference: null },
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

mkdirSync(root, { recursive: true })
for (const name of wanted) {
  const dir = join(root, name)
  if (existsSync(join(dir, "meta.json"))) { console.log(`${name}: already in ${dir}`); continue }
  const t = performance.now()
  await fetchSet(name, dir)
  const docs = readFileSync(join(dir, "corpus.jsonl"), "utf8").split("\n").filter(Boolean).length
  const queries = readFileSync(join(dir, "queries.jsonl"), "utf8").split("\n").filter(Boolean).length
  console.log(`${name}: ${docs} documents, ${queries} queries → ${dir} (${((performance.now() - t) / 1000).toFixed(1)} s)`)
}
