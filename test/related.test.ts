import { afterEach, beforeEach, expect, test } from "bun:test"
import { type Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Config, defaultConfig, saveConfig } from "../src/config.ts"
import { clearIndex, getMeta, openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { SearchClient } from "../src/search/client.ts"
import { mainGeneration, semanticCandidates, semanticFingerprint } from "../src/semantic/indexer.ts"
import { relatedByFile } from "../src/semantic/related.ts"
import { VectorIndex } from "../src/semantic/search.ts"
import { openSemanticDb, packVector, semanticDbPath, setMeta } from "../src/semantic/store.ts"
import { jsonLines } from "./helpers/json-lines.ts"

let work: string, db: Database, config: Config, engine: SearchEngine, source: string, notes: string, contract: string
const previousHome = process.env.ZSEARCH_HOME
const MAIN = join(import.meta.dir, "..", "src/main.ts")
const clients = new Set<ReturnType<typeof jsonLines>>()
const vec = (x: number, y: number) => Float32Array.of(x / Math.hypot(x, y), y / Math.hypot(x, y))

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "zsearch-related-"))
  const docs = join(work, "docs")
  mkdirSync(join(docs, "notes"), { recursive: true })
  mkdirSync(join(docs, "legal"), { recursive: true })
  source = join(docs, "proposal.md"); notes = join(docs, "notes/support.txt"); contract = join(docs, "legal/agreement.txt")
  writeFileSync(source, "A proposal for the harbour restoration project. Budget and timeline.\n")
  writeFileSync(notes, "Supporting project notes on the harbour renewal and construction schedule.\n")
  writeFileSync(contract, "The harbour construction agreement and payment milestones.\n")
  writeFileSync(join(docs, "unrelated.txt"), "Lunar craters and astronomical observations.\n")
  config = { ...defaultConfig(), roots: [docs], autoRefreshMinutes: 0, liveUpdates: false, semantic: { enabled: false, declined: true, code: false } }
  process.env.ZSEARCH_HOME = join(work, "data")
  saveConfig(config)
  db = openDb(join(work, "data/index.db"))
  await new Indexer(db, config, { inProcess: true }).run()
  config = { ...config, semantic: { enabled: true, declined: false, code: false } }
  saveConfig(config)
  const store = openSemanticDb(semanticDbPath(db.filename))!
  setMeta(store, "fingerprint", semanticFingerprint(1))
  setMeta(store, "generation", mainGeneration(db, true)!)
  setMeta(store, "complete_seq", getMeta(db, "change_seq") ?? "0")
  for (const f of semanticCandidates(db, config)) {
    const hash = new Uint8Array(32).fill(f.id)
    const vector = f.path === source ? vec(1, 0) : f.path === notes ? vec(0.98, 0.2) : f.path === contract ? vec(0.9, 0.43) : vec(0.68, Math.sqrt(1 - 0.68 ** 2))
    store.query("INSERT INTO vectors(hash, vec) VALUES (?, ?)").run(hash, packVector(vector, 0, vector.length))
    store.query("INSERT INTO passages(file, n, hash, start, end) VALUES (?, 0, ?, 0, ?)").run(f.id, hash, f.len)
    store.query("INSERT INTO files(file, sig, upto, total) VALUES (?, ?, 1, 1)").run(f.id, f.sig)
  }
  store.close()
  engine = new SearchEngine(db, config)
  // Related discovery must never call a query embedder (nor require installed model/helper files).
  engine.embedQuery = () => { throw new Error("must not embed") }
})
afterEach(async () => {
  for (const c of clients) await c.dispose()
  clients.clear()
  engine.closeSemantic(); db.close()
  if (previousHome === undefined) delete process.env.ZSEARCH_HOME
  else process.env.ZSEARCH_HOME = previousHome
  rmSync(work, { recursive: true, force: true })
})

function changeStore(sql: string) {
  engine.closeSemantic()
  const store = openSemanticDb(semanticDbPath(db.filename))!
  store.exec(sql); store.close()
}

test("related engine ranks across folders, excludes source, bounds output and supplies passage previews", async () => {
  const r = await engine.related(source)
  expect(r.status).toBe("ready")
  expect(r.source?.path).toBe(source)
  expect(r.hits.map((h) => h.path)).toEqual([notes, contract])
  expect(r.hits[0]!.lines[0]!.text).toContain("Supporting project")
  const preview = engine.preview(r.hits[0]!.id, "", "find", r.hits[0]!.lines[0]!.line)
  expect(preview.contentAllowed).not.toBe(false)
  expect(preview.lines.map((l) => l.text).join(" ")).toContain("Supporting project")
  expect((await engine.related(r.source!.id, { limit: 1 })).hits).toHaveLength(1)
  expect((await engine.related(source, { limit: 1 })).total).toBe(2)
})

test("related never uses stale, missing or partly embedded source/candidate vectors", async () => {
  writeFileSync(notes, "Changed since indexing")
  expect((await engine.related(source)).hits.map((h) => h.path)).toEqual([contract])
  writeFileSync(source, "Changed source since indexing")
  expect((await engine.related(source)).status).toBe("pending")
  expect((await engine.related(join(work, "not-indexed"))).status).toBe("missing")
  expect((await engine.related(-1)).status).toBe("missing")
})

test("replacement identities and a rebuild during ranking cannot return stale vectors", async () => {
  const before = statSync(notes)
  rmSync(notes)
  writeFileSync(notes, "x".repeat(before.size))
  utimesSync(notes, before.atime, before.mtime)
  expect((await engine.related(source)).hits.map((h) => h.path)).toEqual([contract])
  const pending = engine.related(source)
  clearIndex(db)
  const response = await pending
  expect(response.status).toBe("pending")
  expect(response.hits).toEqual([])
})

test("index signatures, complete passage state, generation and fingerprint must match", async () => {
  const id = (await engine.related(source)).source!.id
  changeStore(`UPDATE files SET upto = 0 WHERE file = ${id}`)
  expect((await engine.related(source)).status).toBe("pending")
  changeStore("UPDATE files SET upto = total, sig = 'old-text'")
  expect((await engine.related(source)).status).toBe("pending")
  changeStore("UPDATE meta SET value = 'other-model' WHERE key = 'fingerprint'")
  expect((await engine.related(source)).status).toBe("unavailable")
  clearIndex(db)
  expect((await engine.related(source)).status).toBe("missing")
})

test("absent stores and another main-index generation do not compare vectors", async () => {
  changeStore("UPDATE meta SET value = 'different-index' WHERE key = 'generation'")
  expect((await engine.related(source)).status).toBe("unavailable")
  engine.closeSemantic()
  rmSync(semanticDbPath(db.filename))
  expect((await engine.related(source)).status).toBe("unavailable")
})

test("policy changes apply immediately to source and candidates, including names-only and content off", async () => {
  engine.config = { ...config, namesOnly: [join(work, "docs/notes")] }
  expect((await engine.related(source)).hits.map((h) => h.path)).toEqual([contract])
  const denied = await engine.related(notes)
  expect(denied.status).toBe("missing")
  expect(denied.source).toBeUndefined()
  engine.config = { ...config, exclude: [contract] }
  expect((await engine.related(source)).hits.map((h) => h.path)).toEqual([notes])
  writeFileSync(join(work, "docs/.zsearchignore"), "notes/\n")
  expect((await engine.related(source)).hits).toEqual([])
  engine.config = { ...config, semantic: { ...config.semantic, enabled: false } }
  expect((await engine.related(source)).status).toBe("unavailable")
  engine.config = { ...config, content: { ...config.content, enabled: false } }
  expect((await engine.related(source)).status).toBe("unavailable")
})

test("cancellation and policy changes during a yielded scan do not return old hits", async () => {
  expect((await engine.related(source, { cancelled: () => true })).status).toBe("cancelled")
  let cancel = false
  const pending = engine.related(source, { cancelled: () => cancel })
  cancel = true
  expect((await pending).status).toBe("cancelled")
  const changed = engine.related(source)
  engine.config = { ...config, namesOnly: [join(work, "docs")] }
  expect((await changed).status).toBe("cancelled")
})

test("ranking caps source votes, discounts long files, and ignores forbidden rows", async () => {
  const rows = [
    ...Array.from({ length: 40 }, (_, i) => ({ file: 1, start: i, end: i + 1, vector: vec(1, i / 200) })),
    { file: 2, start: 0, end: 1, vector: vec(1, 0) },
    ...Array.from({ length: 100 }, (_, i) => ({ file: 3, start: i, end: i + 1, vector: vec(1, 0) })),
    { file: 4, start: 0, end: 1, vector: vec(1, 0) },
  ]
  const index = VectorIndex.of(rows)
  let scans = 0
  const score = index.score.bind(index)
  index.score = (v) => { scans++; return score(v) }
  const allowed = new Uint8Array(rows.length).fill(1)
  allowed[allowed.length - 1] = 0
  const ranked = await relatedByFile(index, 1, allowed)
  expect(scans).toBe(8)
  expect(ranked!.map((r) => r.file)).toEqual([2, 3])
  // Simulate many passages using the same stored vector (common boilerplate).
  index.vector.fill(0, 41)
  const repeated = await relatedByFile(index, 1, allowed.slice())
  expect(repeated![0]!.file).toBe(2)
  expect(repeated!.find((r) => r.file === 3)!.score).toBeLessThan(ranked!.find((r) => r.file === 3)!.score)
})

test("SearchClient supersedes related operations, cancels in flight, and preserves later searches", async () => {
  const client = new SearchClient(db.filename, config)
  try {
    const old = client.related(source)
    const latest = client.related(contract)
    expect(await old).toBeNull()
    expect((await latest)?.source?.path).toBe(contract)
    const pending = client.related(source)
    client.cancelRelated()
    expect(await pending).toBeNull()
    expect((await client.search("proposal", "find"))?.hits.map((h) => h.path)).toContain(source)
    const abort = new AbortController()
    const stopped = client.related(source, 20, abort.signal)
    abort.abort()
    expect(await stopped).toBeNull()
    const previous = new AbortController()
    const superseded = client.related(source, 20, previous.signal)
    const newer = client.related(contract)
    previous.abort()
    expect(await superseded).toBeNull()
    expect((await newer)?.source?.path).toBe(contract)
  } finally { client.close() }
})

function spawn(command: string) {
  const c = jsonLines(Bun.spawn(["bun", MAIN, command], { env: { ...process.env, ZSEARCH_EMBED: "/no-helper", ZSEARCH_MODELS: join(work, "no-models") }, stdin: "pipe", stdout: "pipe", stderr: "pipe" }))
  clients.add(c)
  return c
}

test("serve protocol validates, returns related hits, and token cancellation cannot stop a newer request", async () => {
  const c = spawn("serve")
  await c.until((m) => m.type === "ready")
  c.send({ id: 1, type: "related", file: source, limit: 1, token: 10 })
  c.send({ id: 2, type: "cancelRelated", token: 9 })
  const result = await c.reply(1)
  expect(result.type).toBe("related")
  expect(result.response.hits.map((h: any) => h.path)).toEqual([notes])
  c.send({ id: 3, type: "related", file: source, limit: -1 })
  expect((await c.reply(3)).type).toBe("error")
  c.send({ id: 4, type: "related", file: source, token: 11 })
  c.send({ id: 5, type: "cancelRelated", token: 11 })
  expect((await c.reply(4)).type).toBe("cancelled")
})

test("CLI related handles relative file paths, limit, JSON, unavailable state and help", async () => {
  const cli = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", MAIN, "related", ...args], { cwd: join(work, "docs"), env: process.env, stdout: "pipe", stderr: "pipe" })
    return { text: await new Response(proc.stdout).text(), error: await new Response(proc.stderr).text(), code: await proc.exited }
  }
  const r = await cli("proposal.md", "--json", "-n", "1")
  expect(r.code).toBe(0)
  expect(JSON.parse(r.text).hits.map((h: any) => h.path)).toEqual([notes])
  expect((await cli(source, "-n", "0")).code).toBe(2)
  expect((await cli("--help")).text).toContain("local passage vectors")
  saveConfig({ ...config, semantic: { ...config.semantic, enabled: false } })
  const off = await cli(source, "--json")
  expect(off.code).toBe(1)
  expect(JSON.parse(off.text).status).toBe("unavailable")
})

test("MCP related_files uses the shared operation and cannot widen local content policy", async () => {
  const c = spawn("mcp")
  await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "related-test", version: "0" } })
  const advertised = (await c.request("tools/list")).result.tools.find((t: any) => t.name === "related_files")
  expect(advertised.annotations.readOnlyHint).toBe(true)
  const call = async (args: Record<string, unknown>) => (await c.request("tools/call", { name: "related_files", arguments: args })).result
  const r = await call({ path: source, limit: 1 })
  expect(r.isError).not.toBe(true)
  expect(r.structuredContent.hits.map((h: any) => h.path)).toEqual([notes])
  saveConfig({ ...config, namesOnly: [join(work, "docs/notes")] })
  expect((await call({ path: source })).structuredContent.hits.map((h: any) => h.path)).toEqual([contract])
  expect((await call({ path: notes })).structuredContent.status).toBe("missing")
  expect((await call({ path: source, roots: ["/"] })).isError).toBe(true)
})
