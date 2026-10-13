import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Config } from "../src/config.ts"
import { clearIndex, openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import type { PowerGate } from "../src/index/power.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { parseQuery } from "../src/search/query.ts"
import { CHUNK_CHARS, chunkText, hasWords, titleOf } from "../src/semantic/chunk.ts"
import { Embedder } from "../src/semantic/helper.ts"
import { SemanticIndexer, type SemanticOptions } from "../src/semantic/indexer.ts"
import { normalize, PotionModel, preTokenize, WordPiece } from "../src/semantic/potion.ts"
import { isLookup, kindHints, meaning, queryTerms, rank, strongCount } from "../src/semantic/search.ts"
import { openSemanticDb, packVector, semanticDbPath, semanticStats, vectorValues } from "../src/semantic/store.ts"
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
    const r = rank({ best, coverage, lookup: false, wordWeight: 2, hinted: new Set(), kindOf: () => "text" })
    expect(r.map((x) => x.file)).toEqual([2, 1])
    expect(r[0]!.score).toBeCloseTo(1.5 + 2)
    const l = rank({ best, coverage, lookup: true, wordWeight: 2, hinted: new Set(["text"]), kindOf: () => "text" })
    expect(l[0]!.score).toBeCloseTo(0.75 + 4 + 1)
    expect(queryTerms("the photo of my Café receipts")).toEqual(["cafe", "receipts"])
    expect(isLookup(queryTerms("TRX50 K7Q2LM"))).toBe(true)
    expect(isLookup(queryTerms("trip 2024"))).toBe(false)
    expect([...kindHints("screenshot of the error")]).toEqual(["image"])
    expect(strongCount([10, 8, 5, 4.9, 1])).toBe(3)
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

  test("queries pick semantic mode with s: and keep their words", () => {
    const q = parseQuery("s:red car*")
    expect(q.forcedMode).toBe("semantic")
    expect(q.words).toEqual(["red", "car*"])
  })
})

describe("Potion", () => {
  test("cuts text as BERT's uncased WordPiece does", () => {
    expect(normalize("Café\tNAÏVE\u0000 東京")).toBe("cafe naive  東  京 ")
    expect(preTokenize("don't stop-me, $5.00!")).toEqual(["don", "'", "t", "stop", "-", "me", ",", "$", "5", ".", "00", "!"])
    const wp = new WordPiece({ "[UNK]": 0, un: 1, "##afford": 2, "##able": 3, house: 4, ",": 5 })
    expect(wp.encode("Unaffordable house, unknownword")).toEqual([1, 2, 3, 4, 5])
    expect(wp.encode("house house house", 2)).toEqual([4, 4])
  })

  test("a text's vector is the normalized average of its pieces' vectors", async () => {
    const model = PotionModel.of({ "[UNK]": 0, cat: 1, dog: 2 }, [[9, 9], [1, 0], [0, 1]])
    const out = new Float32Array(2)
    expect(model.embedInto("cat dog zebra", out)).toBe(2)
    expect(out[0]).toBeCloseTo(Math.SQRT1_2, 3)
    expect(out[1]).toBeCloseTo(Math.SQRT1_2, 3)
    expect(model.embedInto("zebra", out)).toBe(0)
    expect([...out]).toEqual([0, 0])
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
  // Potion's stand-in: the same fake helper, told to see one concept less ("sedan" isn't a vehicle).
  const fakePotion: SemanticOptions["embedder"] = (o) => new Embedder({ ...o, tool, model: "fake.gguf", extra: ["--weak"] })
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
  })

  test("filters apply to meaning matches", async () => {
    const docs = await engine().search("automobile type:image", "semantic")
    expect(docs.hits.some((h) => h.display.startsWith("notes/"))).toBe(false)
  })

  test("Potion's vectors stand in for files Granite hasn't read, and Granite's replace them", async () => {
    const fast = await semantic({ tier: "fast", embedder: fakePotion })
    expect(fast.status).toBe("done")
    // Granite has read every file: Potion's index is not used, and "sedan" is found as a vehicle.
    const both = await engine().search("automobile", "semantic")
    expect(both.hits[0]!.display).toMatch(/^notes\/garage( copy)?\.txt$/)
    // Without Granite's index (not read yet), the files have Potion's vectors only.
    const full = semanticDbPath(dbPath)
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(full + suffix)) renameSync(full + suffix, `${full}${suffix}.away`)
    try {
      const e = engine()
      const r = await e.search("canine", "semantic")
      expect(r.strategy).toBe("semantic + words")
      expect(r.hits[0]!.display).toBe("notes/pets.md")
      // Potion's stand-in doesn't know a sedan is a vehicle; Granite's does.
      expect((await e.search("automobile", "semantic")).hits.some((h) => h.display.startsWith("notes/garage"))).toBe(false)
      e.closeSemantic()
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${full}${suffix}.away`)) renameSync(`${full}${suffix}.away`, full + suffix)
    }
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
    const e = new SearchEngine(db, config)
    e.embedQuery = async () => { throw new Error("helper crashed") }
    const r = await e.search("puppy", "semantic")
    expect(r.notice).toContain("helper crashed")
    expect(r.hits[0]!.display).toBe("notes/pets.md")
    expect((await e.search("puppy", "find")).hits[0]!.display).toBe("notes/pets.md")
    expect((await e.search("pets", "fuzzy")).hits.length).toBeGreaterThan(0)
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

  test("a search engine follows the index when it is removed and made again", async () => {
    const e = engine()
    expect((await e.search("automobile", "semantic")).strategy).toBe("semantic + words")
    for (const tier of ["fast", "full"] as const) for (const suffix of ["", "-wal", "-shm"]) rmSync(semanticDbPath(dbPath, tier) + suffix, { force: true })
    expect((await e.search("automobile", "semantic")).strategy).toBe("words")
    expect((await semantic()).status).toBe("done")
    const r = await e.search("automobile", "semantic")
    expect(r.strategy).toBe("semantic + words")
    expect(r.hits[0]!.display).toMatch(/^notes\/garage( copy)?\.txt$/)
    e.closeSemantic()
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
