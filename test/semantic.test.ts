import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Config } from "../src/config.ts"
import { clearIndex, openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { kindOf, semanticExcluded } from "../src/kinds.ts"
import type { PowerGate } from "../src/index/power.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { parseQuery } from "../src/search/query.ts"
import { CHUNK_CHARS, chunkText, hasWords, titleOf } from "../src/semantic/chunk.ts"
import { Embedder } from "../src/semantic/helper.ts"
import { helperVectorVersion, runSemanticPass, semanticAvailable, SemanticIndexer, type SemanticOptions } from "../src/semantic/indexer.ts"
import { GRANITE, installedModel, MODELS, modelBytes } from "../src/semantic/model.ts"
import { bestByFile, DIGUP_RANKING, isLookup, kindHints, meaning, QueryEmbedder, queryTerms, rank, strongCount, VectorIndex } from "../src/semantic/search.ts"
import { openSemanticDb, packVector, semanticDbPath, semanticStats, setMeta, vectorValues } from "../src/semantic/store.ts"
import { cutFile } from "../src/semantic/cut.ts"
import { CutWorker } from "../src/semantic/workers.ts"
import { homeConfig, makeCorpus } from "./helpers/corpus.ts"

describe("passages", () => {
  const para = (i: number) => `Paragraph ${i} talks about topic number ${i} at some length. `.repeat(6)
  const doc = Array.from({ length: 40 }, (_, i) => para(i)).join("\n\n")

  test("are whole paragraphs of at most CHUNK_CHARS characters", () => {
    const chunks = chunkText(doc)
    expect(chunks.length).toBeGreaterThan(5)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_CHARS)
      expect(c.text.startsWith("Paragraph")).toBe(true)
    }
    expect(chunkText(doc, 3)).toHaveLength(3)
  })

  test("an edit changes only the passages near it", () => {
    const before = chunkText(doc).map((c) => c.text)
    const edited = doc.replace(para(20), para(20).replace("some length", "great length, with a new sentence added"))
    const after = chunkText(edited).map((c) => c.text)
    const same = after.filter((t) => before.includes(t)).length
    expect(same).toBeGreaterThanOrEqual(after.length - 2)
  })

  test("long lines and runs without spaces are cut too", () => {
    for (const c of chunkText("word ".repeat(2000))) expect(c.text.length).toBeLessThanOrEqual(CHUNK_CHARS)
    for (const c of chunkText("x".repeat(5000))) expect(c.text.length).toBeLessThanOrEqual(CHUNK_CHARS)
  })

  test("text of digits has no words, and copies share their title", () => {
    expect(hasWords("12 34 56 78 90 11 22 33 44 55, 1.5, 2.25")).toBe(false)
    expect(hasWords("The meeting is at 10:30 in room 4")).toBe(true)
    expect(titleOf("report (1).pdf")).toBe("report")
    expect(titleOf("report copy.pdf")).toBe("report")
    expect(titleOf("report - Copy (2).docx")).toBe("report")
    expect(titleOf(".bashrc")).toBe(".bashrc")
  })
})

describe("DigUp's ranking", () => {
  test("meaning scores are deviations from the modality's average", () => {
    const scores = [...Array(30).fill(0.2), 0.6]
    const z = meaning(scores, Array(31).fill(0))
    expect(z[30]!).toBeGreaterThan(4)
    expect(Math.abs(z[0]!)).toBeLessThan(0.5)
  })

  test("a small modality takes the average of all, and later passages don't set the scale", () => {
    const scores = [...Array(30).fill(0.2), 0.3, 0.3]
    const z = meaning(scores, [...Array(30).fill(0), 1, 1])
    // Two image vectors are too few for an average of their own: they stand out against the text.
    expect(z[30]!).toBeGreaterThan(2)
    const withLater = meaning([...scores, ...Array(500).fill(0.9)], [...Array(32).fill(0), ...Array(500).fill(0)], [...Array(32).fill(1), ...Array(500).fill(0)])
    expect(withLater[30]!).toBeCloseTo(z[30]!, 5)
  })

  test("candidates stand out or hold half the words; lookups weigh words", () => {
    const best = new Map([[1, { z: 3, row: 0 }], [2, { z: 1.5, row: 1 }], [3, { z: 0.5, row: 2 }]])
    const coverage = new Map([[2, 1], [3, 0.4]])
    const r = rank({ best, coverage, lookup: false, wordWeight: 2, hinted: new Set(), kindOf: () => "text", ranking: DIGUP_RANKING })
    expect(r.map((x) => x.file)).toEqual([2, 1])
    // The comparison pipeline retains the previous additive scoring.
    expect(r[0]!.score).toBeCloseTo(1.5 + 2)
    const l = rank({ best, coverage, lookup: true, wordWeight: 2, hinted: new Set(["text"]), kindOf: () => "text", ranking: DIGUP_RANKING })
    expect(l[0]!.score).toBeCloseTo(0.75 + 4 + 1)
    expect(queryTerms("the photo of my Café receipts")).toEqual(["cafe", "receipts"])
    expect(isLookup(queryTerms("TRX50 K7Q2LM"))).toBe(true)
    expect(isLookup(queryTerms("trip 2024"))).toBe(false)
    expect([...kindHints("screenshot of the error")]).toEqual(["image"])
    expect(strongCount([10, 8, 5, 4.9, 1])).toBe(3)
  })

  test("semantic answers can beat incidental word matches, while saved filenames get a finite boost", () => {
    const best = new Map([[1, { z: 0.2, row: 0 }], [2, { z: 1.5, row: 1 }], [3, { z: 6, row: 2 }], [4, { z: 9, row: 3 }]])
    const coverage = new Map([[1, 1], [2, 1], [3, 0.5]])
    const r = rank({ best, coverage, lookup: false, wordWeight: 2, hinted: new Set(), kindOf: () => "text" })
    expect(r.map(x => x.file)).toEqual([4, 3, 2, 1])
    const named = rank({ best: new Map([[7, { z: 3, row: 0 }], [8, { z: 2, row: 1 }]]), coverage: new Map([[7, 1], [8, 1]]), named: new Map([[8, 1]]), lookup: false, wordWeight: 2, hinted: new Set(), kindOf: () => "text" })
    expect(named.map(x => x.file)).toEqual([8, 7])
    // Codes remain exact word lookups rather than natural-language questions.
    const lookup = rank({ best: new Map([[1, { z: 5, row: 0 }]]), coverage: new Map([[2, 1]]), lookup: true, wordWeight: 2, hinted: new Set(), kindOf: () => "text" })
    expect(lookup[0]!.file).toBe(2)
    expect(queryTerms("how much did the plumber charge")).toEqual(["much", "plumber", "charge"])
  })

  test("without vectors, word matches follow coverage and keyword order, and long queries need only three words", () => {
    const none = new Map<number, { z: number; row: number }>()
    // Eight content words: three of them make a match; more words, then keyword order, rank first.
    const r = rank({ best: none, coverage: new Map([[1, 3 / 8], [2, 5 / 8], [3, 5 / 8], [4, 2 / 8]]), strength: new Map([[1, 1], [2, 0.2], [3, 0.9]]), terms: 8, lookup: false, wordWeight: 2, hinted: new Set(), kindOf: () => "text" })
    expect(r.map(x => x.file)).toEqual([3, 2, 1])
    // Short queries still need half their words.
    expect(rank({ best: none, coverage: new Map([[1, 1 / 4]]), terms: 4, lookup: false, wordWeight: 2, hinted: new Set(), kindOf: () => "text" })).toEqual([])
  })

  test("Granite readiness requires the current sequence and passage completion", () => {
    const index = new VectorIndex()
    index.completeSeq = "12"
    expect(index.isCompleteFor("12")).toBe(true)
    expect(index.isCompleteFor("13")).toBe(false)
    index.complete = false
    expect(index.isCompleteFor("12")).toBe(false)
    index.complete = true; index.completeSeq = null
    expect(index.isCompleteFor("12")).toBe(false)
  })

  test("completed numeric passages need no vectors, but missing referenced vectors block readiness", () => {
    const db = openSemanticDb(":memory:")!
    try {
      setMeta(db, "complete_seq", "12")
      db.exec("INSERT INTO files VALUES (1, 'sig', 2, 2, NULL)")
      // Passage 1 is digits only, deliberately skipped by the cutter.
      const hash = new Uint8Array(16)
      db.query("INSERT INTO passages VALUES (1, 0, ?, 0, 10)").run(hash)
      db.query("INSERT INTO vectors VALUES (?, ?)").run(hash, packVector(new Float32Array([1, 0]), 0, 2))
      expect(VectorIndex.load(db).isCompleteFor("12")).toBe(true)
      db.exec("DELETE FROM vectors")
      expect(VectorIndex.load(db).isCompleteFor("12")).toBe(false)
    } finally { db.close() }
  })

  test("Granite's strong concepts stay eligible without a second model", () => {
    const index = VectorIndex.of([{ file: 1, start: 0, end: 1, vector: new Float32Array([1, 0]) }])
    const best = bestByFile(index, new Float64Array([4]), () => true)
    expect(best.get(1)!.z).toBe(4)
    expect(rank({ best, coverage: new Map(), lookup: false, wordWeight: 2, hinted: new Set(), kindOf: () => "text" }).map(r => r.file)).toEqual([1])
    expect(bestByFile(index, new Float64Array([4]), () => false).size).toBe(0)
  })

  test("the best of a long file's many passages stands out by less", () => {
    const v = new Float32Array([1, 0])
    const index = VectorIndex.of([{ file: 1, start: 0, end: 1, vector: v }, ...Array.from({ length: 20 }, (_, n) => ({ file: 2, start: n, end: n + 1, vector: v }))])
    const best = bestByFile(index, new Float64Array(21).fill(3), () => true)
    expect(best.get(1)!.z).toBeCloseTo(3)
    expect(best.get(2)!.z).toBeLessThan(2.2)
    // A passage 20 files share (a header they all repeat) says little about any one of them.
    const shared = VectorIndex.of(Array.from({ length: 20 }, (_, n) => ({ file: n + 1, start: 0, end: 1, vector: v })))
    shared.vector.fill(0)
    expect(bestByFile(shared, new Float64Array(20).fill(3), () => true).get(1)!.z).toBeLessThan(1.6)
  })

  test("Lean files are left to find and fuzzy", () => {
    expect(kindOf("Continuity.lean")).toBe("code")
    expect(kindOf("Continuity.olean")).toBe("app")
    expect(semanticExcluded("/home/me/proofs/Continuity.lean")).toBe(true)
    expect(semanticExcluded("/home/me/proofs/.lake/build/Continuity.ilean")).toBe(true)
    expect(semanticExcluded("/home/me/notes/lean-recipes.md")).toBe(false)
  })

  test("vectors keep their direction in 16 bits", () => {
    const v = new Float32Array(768).map((_, i) => Math.sin(i) / 20)
    const packed = packVector(v, 0, 768)
    expect(packed.length).toBe(1536)
    const h = vectorValues(packed, 768)!
    let dot = 0, a = 0, b = 0
    for (let i = 0; i < 768; i++) { dot += v[i]! * h[i]!; a += v[i]! ** 2; b += h[i]! ** 2 }
    expect(dot / Math.sqrt(a * b)).toBeGreaterThan(0.99999)
    expect(vectorValues(packed.subarray(2), 768)).toBeNull()
  })

  test("a version 2 index keeps its vectors, passages and model in the new layout", () => {
    const dir = mkdtempSync(join(tmpdir(), "zsearch-store-"))
    try {
      const path = join(dir, "index.semantic.db")
      const old = new Database(path, { create: true, strict: true })
      old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
      old.exec("CREATE TABLE vectors (hash BLOB PRIMARY KEY, vec BLOB NOT NULL) WITHOUT ROWID")
      old.exec("CREATE TABLE passages (file INTEGER NOT NULL, n INTEGER NOT NULL, hash BLOB NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, PRIMARY KEY (file, n)) WITHOUT ROWID")
      old.exec("CREATE INDEX passages_hash ON passages(hash)")
      old.exec("CREATE TABLE files (file INTEGER PRIMARY KEY, sig TEXT NOT NULL, upto INTEGER NOT NULL, total INTEGER NOT NULL, note TEXT)")
      old.exec("INSERT INTO meta VALUES ('schema_version', '2'), ('fingerprint', 'granite')")
      const vec = packVector(new Float32Array(768).fill(0.5), 0, 768)
      const insert = old.prepare("INSERT INTO vectors VALUES (?, ?)")
      for (let i = 0; i < 50; i++) insert.run(new Uint8Array(16).fill(i), vec)
      old.exec("INSERT INTO passages VALUES (1, 0, x'00000000000000000000000000000000', 0, 10)")
      old.exec("INSERT INTO files VALUES (1, 'sig', 1, 1, NULL)")
      old.close()

      const db = openSemanticDb(path)!
      expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "3" })
      expect(db.query("SELECT value FROM meta WHERE key = 'fingerprint'").get()).toEqual({ value: "granite" })
      const stats = semanticStats(db)
      expect([stats.vectors, stats.passages, stats.files]).toEqual([50, 1, 1])
      expect((db.query("SELECT vec FROM vectors WHERE hash = ?").get(new Uint8Array(16).fill(7)) as { vec: Uint8Array }).vec).toEqual(vec)
      expect(db.query("SELECT sql FROM sqlite_schema WHERE name = 'vectors'").get()).toEqual({ sql: expect.not.stringContaining("WITHOUT ROWID") })
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("queries pick semantic mode with s: and keep their words", () => {
    const q = parseQuery("s:red car*")
    expect(q.forcedMode).toBe("semantic")
    expect(q.words).toEqual(["red", "car*"])
  })
})

describe("Granite passage worker", () => {
  test("cuts batches just like the indexer, without an embedding model", async () => {
    const workers = new CutWorker()
    try {
      const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} is about the cat and the dog. `.repeat(8)).join("\n\n")
      const data = new Uint8Array([0, ...new TextEncoder().encode(text)])
      const jobs = Array.from({ length: 50 }, () => ({ data, name: "pets (1).txt", from: 0, cap: 3 }))
      const cuts = await workers.cut(jobs)
      expect(cuts).toEqual(jobs.map(cutFile))
      expect(cuts[0]!.to).toBe(3)
      expect(cuts[0]!.total).toBe(chunkText(text).length)
      expect(cuts[0]!.passages[0]!.prompt.startsWith("pets\n\nParagraph 0")).toBe(true)
    } finally { workers.close() }
  })
})

describe("query model", () => {
  /** A stand-in model: counts what it is asked, and whether it was stopped. */
  const fake = () => {
    const log = { started: 0, texts: [] as string[], closed: 0 }
    const start = () => {
      log.started++
      return {
        embedTexts: async (texts: string[]) => { log.texts.push(...texts); return { vectors: new Float32Array([1, 0]), dim: 2, tokens: 1 } },
        close: () => { log.closed++ },
        kill: () => { log.closed++ },
      }
    }
    return { log, start }
  }

  test("warm starts the model once, before the first query", async () => {
    const { log, start } = fake()
    const q = new QueryEmbedder(start)
    await q.warm()
    await q.warm()
    await q.embed("red car")
    expect(log.started).toBe(1)
    expect(log.texts).toHaveLength(2)
    q.close()
  })

  test("stops when idle, unless kept running", async () => {
    const idle = fake()
    const q = new QueryEmbedder(idle.start, 5)
    await q.embed("red car")
    await Bun.sleep(30)
    expect(idle.log.closed).toBe(1)

    const kept = fake()
    const k = new QueryEmbedder(kept.start, Infinity)
    await k.warm()
    await k.embed("red car")
    await Bun.sleep(30)
    expect(kept.log.closed).toBe(0)
    k.close()
    expect(kept.log.closed).toBe(1)
  })
})

describe("semantic index and search", () => {
  let corpus: ReturnType<typeof makeCorpus>
  let db: Database
  let config: Config
  let dbPath: string
  let tool: string
  let log: string
  let work: string
  const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME, ZSEARCH_MODELS: process.env.ZSEARCH_MODELS }

  const requests = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { op: string; n: number; texts?: string[]; paths?: string[] }) : [])
  const embeddedTexts = () => requests().filter((r) => r.op === "t").flatMap((r) => r.texts!)
  const resetLog = () => rmSync(log, { force: true })
  const fakeEmbedder: SemanticOptions["embedder"] = (o) => new Embedder({ ...o, tool, model: "fake.gguf" })
  const semantic = (opts: SemanticOptions = {}) => new SemanticIndexer(db, config, tool, { embedder: fakeEmbedder, vectorVersion: 1, ...opts }).run()
  const store = () => openSemanticDb(semanticDbPath(dbPath))!
  const engine = () => {
    const e = new SearchEngine(db, config)
    e.embedQuery = async (text) => {
      const h = new Embedder({ tool, model: "fake.gguf" })
      try { return (await h.embedTexts([text])).vectors } finally { h.close() }
    }
    return e
  }

  beforeAll(async () => {
    corpus = makeCorpus()
    process.env.HOME = corpus.home
    process.env.ZSEARCH_HOME = join(corpus.home, ".zsearch-data")
    // Outside the indexed folder: the log holds what was embedded.
    work = mkdtempSync(join(tmpdir(), "zsearch-embed-"))
    log = join(work, "embed.log")
    process.env.FAKE_EMBED_LOG = log
    tool = join(work, "fake-embed")
    writeFileSync(tool, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "helpers", "fake-embed.ts")}" "$@"\n`)
    chmodSync(tool, 0o755)
    corpus.write("notes/garage.txt", "My sedan needs new tyres before winter.\n\nThe mechanic also said the brakes are worn.\n")
    corpus.write("notes/pets.md", "# Pets\n\nOur puppy chewed the sofa again.\n")
    corpus.write("notes/orders.txt", "Order K7Q2LM shipped on Monday. Tracking will follow.\n")
    corpus.write("notes/deploy.txt", "Deployed commit 3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a to production on Friday.\n")
    corpus.write("Documents/credentials", "user=admin password=hunter2 sedan\n")
    corpus.write("proofs/Kennel.lean", "/-- A dog in its kennel chews the sofa. -/\ntheorem kennel_sofa : True := trivial\n")
    dbPath = join(corpus.home, ".zsearch-data", "index.db")
    db = openDb(dbPath)
    config = { ...homeConfig(), semantic: { enabled: true, declined: false, code: false } }
    await new Indexer(db, config, { inProcess: true }).run()
  })

  afterAll(() => {
    db.close()
    corpus.cleanup()
    rmSync(work, { recursive: true, force: true })
    delete process.env.FAKE_EMBED_LOG
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  })

  test("embeds the text the index read, but not keys, code or data", async () => {
    const r = await semantic()
    expect(r.status).toBe("done")
    expect(r.embedded).toBeGreaterThan(5)
    const texts = embeddedTexts()
    expect(texts.some((t) => t.startsWith("garage\n\nMy sedan"))).toBe(true)
    expect(texts.some((t) => t.includes("hunter2"))).toBe(false)
    expect(texts.some((t) => t.includes("getUserName"))).toBe(false)
    expect(texts.some((t) => t.includes("MAX_RETRIES"))).toBe(false)
    expect(texts.some((t) => t.includes("kennel_sofa"))).toBe(false)
    const s = store()
    const stats = semanticStats(s)
    s.close()
    expect(stats.files).toBeGreaterThan(5)
    expect(stats.partial).toBe(0)
  })

  test("a run with nothing new embeds nothing", async () => {
    resetLog()
    const r = await semantic()
    expect(r.status).toBe("done")
    expect(r.embedded).toBe(0)
    expect(requests()).toHaveLength(0)
  })

  test("a helper whose version can't be read fails the pass and keeps the stored vectors", async () => {
    const mute = join(work, "mute-embed")
    writeFileSync(mute, "#!/bin/sh\nexit 1\n")
    chmodSync(mute, 0o755)
    expect(helperVectorVersion(tool)).toBe(1)
    expect(helperVectorVersion(mute)).toBeNull()
    const files = () => { const s = store(); try { return semanticStats(s).files } finally { s.close() } }
    const before = files()
    expect(before).toBeGreaterThan(5)
    const r = await new SemanticIndexer(db, config, mute, { embedder: fakeEmbedder }).run()
    expect(r.status).toBe("error")
    expect(r.error).toContain("version")
    expect(files()).toBe(before)
    expect((await semantic()).embedded).toBe(0)
  })

  test("copies, edits and a rebuilt index reuse the vectors they can", async () => {
    resetLog()
    corpus.write("notes/garage copy.txt", readFileSync(join(corpus.home, "notes/garage.txt")))
    corpus.write("notes/garage.txt", "My sedan needs new tyres before winter.\n\nThe mechanic also said the brakes are worn, and the oil is due.\n")
    await new Indexer(db, config, { inProcess: true }).run()
    const r = await semantic()
    expect(r.status).toBe("done")
    // The copy shares its title and text with the old version: nothing to embed for it. The edit
    // is one passage.
    expect(embeddedTexts()).toEqual(["garage\n\nMy sedan needs new tyres before winter.\n\nThe mechanic also said the brakes are worn, and the oil is due."])
    expect(r.reused).toBeGreaterThan(0)

    resetLog()
    clearIndex(db)
    await new Indexer(db, config, { inProcess: true }).run()
    // New file ids: until the semantic pass catches up, its passages aren't used.
    const between = await engine().search("automobile", "semantic")
    expect(between.strategy).toBe("words")
    expect(between.notice).toContain("next index update")
    const again = await semantic()
    expect(again.status).toBe("done")
    expect(again.embedded).toBe(0)
    expect(requests()).toHaveLength(0)
  })

  test("finds by meaning what has none of the query's words", async () => {
    const r = await engine().search("automobile", "semantic")
    expect(r.error).toBeUndefined()
    expect(r.resolved).toBe("semantic")
    expect(r.strategy).toBe("semantic + words")
    expect(r.hits[0]!.display).toMatch(/^notes\/garage( copy)?\.txt$/)
    expect(r.hits[0]!.lines[0]!.text).toContain("sedan")
    expect(r.hits.some((h) => h.display === "Documents/credentials")).toBe(false)
    const pets = await engine().search("canine", "semantic")
    expect(pets.hits[0]!.display).toBe("notes/pets.md")
    // Lean proofs are for find, not for the semantic tab, even by their words.
    expect((await engine().search("kennel sofa", "semantic")).hits.some((h) => h.display.endsWith(".lean"))).toBe(false)
    expect((await engine().search("kennel_sofa", "find")).hits.map((h) => h.display)).toContain("proofs/Kennel.lean")
  })

  test("saved-name lookups show the document heading and directories stay out of semantic results", async () => {
    corpus.write("notes/handbook.txt", "Employee Handbook\n\nCompany working hours and holiday rules.\n")
    await new Indexer(db, config, { inProcess: true }).run()
    const e = engine()
    const r = await e.search("handbook", "semantic")
    expect(r.hits[0]!.display).toBe("notes/handbook.txt")
    expect(r.hits[0]!.lines[0]!.text).toBe("Employee Handbook")
    expect((await e.search("notes", "semantic")).hits.every(h => !h.isDir)).toBe(true)
    e.closeSemantic()
    // Finish Granite so the next test can use the current snapshot.
    expect((await semantic()).status).toBe("done")
  })

  test("filters apply to meaning matches", async () => {
    const docs = await engine().search("automobile type:image", "semantic")
    expect(docs.hits.some((h) => h.display.startsWith("notes/"))).toBe(false)
    // Only the words go to the model, not the filters.
    const asked: string[] = []
    const e = engine()
    const embed = e.embedQuery!
    e.embedQuery = (text) => { asked.push(text); return embed(text) }
    await e.search("canine type:text", "semantic")
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((t) => t === "canine")).toBe(true)
  })

  test("only Granite is required, and an index run embeds one model", async () => {
    const models = join(work, "models")
    mkdirSync(models, { recursive: true })
    writeFileSync(join(models, GRANITE.files[0]!.name), "test model")
    const previous = process.env.ZSEARCH_MODELS
    process.env.ZSEARCH_MODELS = models
    try {
      expect(MODELS).toEqual([GRANITE])
      expect(modelBytes()).toBe(52_445_632)
      expect(installedModel(GRANITE)).not.toBeNull()
      expect(semanticAvailable(config, tool)).toBeNull()
      expect(semanticAvailable(config, null)).toContain("helper")
      expect((await runSemanticPass(db, config, null)).status).toBe("skipped")
      corpus.write("notes/granite-only.txt", "My puppy needs a walk before we leave.\n")
      await new Indexer(db, config, { inProcess: true }).run()
      resetLog()
      expect((await runSemanticPass(db, config, tool, { embedder: fakeEmbedder, vectorVersion: 1 })).status).toBe("done")
      expect(embeddedTexts()).toEqual(["granite-only\n\nMy puppy needs a walk before we leave."])
      expect(existsSync(semanticDbPath(dbPath).replace(/\.db$/, "-fast.db"))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.ZSEARCH_MODELS; else process.env.ZSEARCH_MODELS = previous
      rmSync(join(corpus.home, "notes/granite-only.txt"))
      await new Indexer(db, config, { inProcess: true }).run()
      expect((await semantic()).status).toBe("done")
    }
  })

  test("edits invalidate Granite until it catches up, while current word matches remain", async () => {
    corpus.write("notes/errands.txt", "Errands for Saturday: groceries and laundry.\n")
    await new Indexer(db, config, { inProcess: true }).run()
    expect((await semantic()).status).toBe("done")
    const e = engine()
    expect((await e.search("canine", "semantic")).strategy).toBe("semantic + words")
    corpus.write("notes/errands.txt", "Errands for Saturday: walk the puppy, then groceries and laundry.\n")
    await new Indexer(db, config, { inProcess: true }).run()
    const r = await e.search("puppy", "semantic")
    expect(r.strategy).toBe("words")
    expect(r.notice).toContain("Granite is not ready")
    expect(r.hits.some((h) => h.display === "notes/errands.txt")).toBe(true)
    expect((await e.search("canine", "semantic")).hits.some(h => h.display === "notes/errands.txt")).toBe(false)
    expect((await semantic()).status).toBe("done")
    // A completed replacement is available immediately to the same engine.
    expect((await e.search("canine", "semantic")).hits.some(h => h.display === "notes/errands.txt")).toBe(true)
    e.closeSemantic()
    rmSync(join(corpus.home, "notes/errands.txt"))
    await new Indexer(db, config, { inProcess: true }).run()
    expect((await semantic()).status).toBe("done")
  })

  test("codes are looked up by their words", async () => {
    const r = await engine().search("K7Q2LM", "semantic")
    expect(r.hits[0]!.display).toBe("notes/orders.txt")
    expect(r.hits[0]!.lines[0]!.text).toContain("K7Q2LM")
  })

  test("long codes such as commit hashes are looked up whole and by their start", async () => {
    // The index may keep long words in a shorter form; word matching must find them all the same.
    // Words only (no model), so that meaning can't find the file instead.
    const e = new SearchEngine(db, config)
    e.embedQuery = null
    const r = await e.search("3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a ", "semantic")
    expect(r.strategy).toBe("words")
    expect(r.hits[0]?.display).toBe("notes/deploy.txt")
    // Still typing: the last word is a prefix.
    const typing = await e.search("3f9a1c7e5b2d4f6a8", "semantic")
    expect(typing.hits[0]?.display).toBe("notes/deploy.txt")
    // And a word left out leaves out the files that hold it.
    const without = await e.search("production -3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a ", "semantic")
    expect(without.hits.map((h) => h.display)).not.toContain("notes/deploy.txt")
  })

  test("a prefix many long words share only matches files holding it", async () => {
    // More long words start with the prefix than are listed one by one, so the index is asked for
    // their first characters only; a file whose word differs after those must not count.
    const many = Array.from({ length: 70 }, (_, i) => `abcdefabcdefa${i.toString(36).padStart(2, "0")}${"x".repeat(49)}`)
    corpus.write("notes/many.txt", `${many.join(" ")}\n`)
    corpus.write("notes/other.txt", `abcdefabcdefb${"y".repeat(51)}\n`)
    await new Indexer(db, config, { inProcess: true }).run()
    const e = new SearchEngine(db, config)
    e.embedQuery = null
    const r = await e.search("abcdefabcdefa", "semantic")
    const shown = r.hits.map((h) => h.display)
    expect(shown).toContain("notes/many.txt")
    expect(shown).not.toContain("notes/other.txt")
    rmSync(join(corpus.home, "notes/many.txt"))
    rmSync(join(corpus.home, "notes/other.txt"))
    await new Indexer(db, config, { inProcess: true }).run()
  })

  test("without the model it says so and shows word matches", async () => {
    const e = new SearchEngine(db, config)
    e.embedQuery = null
    const r = await e.search("puppy", "semantic")
    expect(r.notice).toContain("zsearch semantic install")
    expect(r.strategy).toBe("words")
    expect(r.hits[0]!.display).toBe("notes/pets.md")
    const off = new SearchEngine(db, { ...config, semantic: { ...config.semantic, enabled: false } })
    expect((await off.search("puppy", "semantic")).notice).toContain("off")
  })

  test("a failing helper is reported, and find and fuzzy don't need it", async () => {
    expect((await semantic()).status).toBe("done")
    const e = new SearchEngine(db, config)
    e.embedQuery = async () => { throw new Error("helper crashed") }
    const r = await e.search("puppy", "semantic")
    expect(r.notice).toContain("helper crashed")
    expect(r.hits[0]!.display).toBe("notes/pets.md")
    expect((await e.search("puppy", "find")).hits[0]!.display).toBe("notes/pets.md")
    expect((await e.search("pets", "fuzzy")).hits.length).toBeGreaterThan(0)
  })

  test("an index update picked up while the query is embedded is searched as updated", async () => {
    corpus.write("notes/release.txt", "The zephyr release is ready.\n")
    await new Indexer(db, config, { inProcess: true }).run()
    expect((await semantic()).status).toBe("done")
    const e = engine()
    const embed = e.embedQuery!
    let answer!: () => void
    // A meaning only the garage notes have: the release note can come in by its words alone.
    e.embedQuery = async () => { await new Promise<void>((r) => { answer = r }); return embed("automobile") }
    const pending = e.search("zephyr", "semantic")
    // While the query is embedded, the note loses the word and the engine takes in the update.
    corpus.write("notes/release.txt", "The breeze release is ready now.\n")
    await new Indexer(db, config, { inProcess: true }).run()
    e.refresh(true)
    answer()
    const r = await pending
    expect(r.strategy).toBe("semantic + words")
    expect(r.hits.map((h) => h.display)).not.toContain("notes/release.txt")
    e.closeSemantic()
    rmSync(join(corpus.home, "notes/release.txt"))
    await new Indexer(db, config, { inProcess: true }).run()
    expect((await semantic()).status).toBe("done")
  })

  test("a big background run waits on power, and goes when asked", async () => {
    for (let i = 0; i < 110; i++) corpus.write(`bulk/note-${i}.txt`, `Note ${i} about the vacation planning, part ${i}.\n`)
    await new Indexer(db, config, { inProcess: true }).run()
    resetLog()
    const power = { reason: () => "Low Power Mode" } as unknown as PowerGate
    const controller = new AbortController()
    const waits: (string | undefined)[] = []
    const pending = semantic({ power, signal: controller.signal, onProgress: (p) => waits.push(p.waiting) })
    await Bun.sleep(300)
    expect(waits).toContain("Low Power Mode")
    expect(requests()).toHaveLength(0)
    controller.abort()
    expect((await pending).status).toBe("cancelled")

    let go = false
    const run = semantic({ power, goNow: () => go })
    await Bun.sleep(200)
    go = true
    const r = await run
    expect(r.status).toBe("done")
    expect(r.files).toBeGreaterThanOrEqual(110)
  })

  test("partial Granite uses words and does not embed at search time", async () => {
    const s = store()
    const ids = (db.query("SELECT id FROM files WHERE name LIKE 'garage%'").values() as number[][]).map((r) => r[0]!)
    for (const id of ids) { s.query("DELETE FROM passages WHERE file = ?").run(id); s.query("DELETE FROM files WHERE file = ?").run(id) }
    s.exec("UPDATE files SET upto = 0 WHERE total > 0")
    s.close()
    const e = engine()
    const original = e.embedQuery!
    let fullCalls = 0
    e.embedQuery = async (text) => { fullCalls++; return original(text) }
    const r = await e.search("automobile", "semantic")
    expect(r.hits.some(h => h.display.startsWith("notes/garage"))).toBe(false)
    expect(r.strategy).toBe("words")
    expect(r.notice).toContain("Granite is not ready")
    expect(fullCalls).toBe(0)
    e.closeSemantic()
    expect((await semantic()).status).toBe("done")
  })

  test("a search engine follows the index when it is removed and made again", async () => {
    const e = engine()
    expect((await e.search("automobile", "semantic")).strategy).toBe("semantic + words")
    for (const suffix of ["", "-wal", "-shm"]) rmSync(semanticDbPath(dbPath) + suffix, { force: true })
    expect((await e.search("automobile", "semantic")).strategy).toBe("words")
    expect((await semantic()).status).toBe("done")
    const r = await e.search("automobile", "semantic")
    expect(r.strategy).toBe("semantic + words")
    expect(r.hits[0]!.display).toMatch(/^notes\/garage( copy)?\.txt$/)
    e.closeSemantic()
  })

  test("a cancelled long-file pass resumes from committed Granite vectors", async () => {
    const text = Array.from({ length: 100 }, (_, n) => `Vacation planning paragraph ${n}. ${"Book the train and hotel before the holiday. ".repeat(30)}`).join("\n\n")
    corpus.write("notes/long-trip.txt", text)
    await new Indexer(db, config, { inProcess: true }).run()
    const controller = new AbortController()
    const first = await semantic({ signal: controller.signal, onCommit: () => controller.abort() })
    expect(first.status).toBe("cancelled")
    const s = store()
    // Find this file by its main-index id, since other complete files are retained.
    const id = (db.query("SELECT id FROM files WHERE name = 'long-trip.txt'").get() as { id: number }).id
    const partial = s.query("SELECT upto, total FROM files WHERE file = ?").get(id) as { upto: number; total: number }
    expect(partial.upto).toBe(40)
    expect(partial.total).toBeGreaterThan(partial.upto)
    expect(VectorIndex.load(s).complete).toBe(false)
    s.close()
    resetLog()
    const resumed = await semantic()
    expect(resumed.status).toBe("done")
    expect(resumed.embedded).toBe(partial.total - partial.upto)
    expect(embeddedTexts().every(t => !t.includes("Vacation planning paragraph 0."))).toBe(true)
    rmSync(join(corpus.home, "notes/long-trip.txt"))
    await new Indexer(db, config, { inProcess: true }).run()
    expect((await semantic()).status).toBe("done")
  })

  test("cancelling doesn't wait for a helper that hangs", async () => {
    corpus.write("notes/hang.txt", "This one says HANG_EMBED to the fake helper.\n")
    await new Indexer(db, config, { inProcess: true }).run()
    const controller = new AbortController()
    const started = Date.now()
    const run = semantic({ signal: controller.signal })
    await Bun.sleep(300)
    controller.abort()
    const r = await run
    expect(r.status).toBe("cancelled")
    expect(Date.now() - started).toBeLessThan(2000)
    rmSync(join(corpus.home, "notes/hang.txt"))
    await new Indexer(db, config, { inProcess: true }).run()
  })

  test("a helper error is kept for status, and the next run tries again", async () => {
    corpus.write("notes/fail.txt", "This one says FAIL_EMBED to the fake helper.\n")
    await new Indexer(db, config, { inProcess: true }).run()
    const r = await semantic()
    expect(r.status).toBe("error")
    expect(r.error).toContain("made to fail")
    const s = store()
    expect(semanticStats(s).error).toContain("made to fail")
    s.close()
    rmSync(join(corpus.home, "notes/fail.txt"))
    await new Indexer(db, config, { inProcess: true }).run()
    const next = await semantic()
    expect(next.error).toBeUndefined()
    expect(next.status).toBe("done")
  })
})
