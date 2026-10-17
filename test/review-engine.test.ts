import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Config } from "../src/config.ts"
import { openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine, type SearchResponse } from "../src/search/engine.ts"
import { Embedder } from "../src/semantic/helper.ts"
import { semanticFingerprint, SemanticIndexer } from "../src/semantic/indexer.ts"
import { GRANITE } from "../src/semantic/model.ts"
import { openSemanticDb, semanticDbPath, setMeta } from "../src/semantic/store.ts"
import { homeConfig, makeCorpus } from "./helpers/corpus.ts"

let corpus: ReturnType<typeof makeCorpus>
let db: Database
let config: Config
let dbPath: string
let tool: string
let log: string
let work: string
const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME, ZSEARCH_MODELS: process.env.ZSEARCH_MODELS, ZSEARCH_EMBED: process.env.ZSEARCH_EMBED }

const names = (r: SearchResponse) => r.hits.map((h) => h.display)
const index = () => new Indexer(db, config, { inProcess: true }).run()
const embeddedTexts = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { op: string; texts?: string[] }) : []).filter((r) => r.op === "t").flatMap((r) => r.texts!)
const semantic = () => new SemanticIndexer(db, config, tool, { embedder: (o) => new Embedder({ ...o, tool, model: "fake.gguf" }), vectorVersion: 1 }).run()
const fakeVector = async (text: string) => {
  const h = new Embedder({ tool, model: "fake.gguf" })
  try { return (await h.embedTexts([text])).vectors } finally { h.close() }
}
const engine = (c: Config = config) => {
  const e = new SearchEngine(db, c)
  e.embedQuery = fakeVector
  return e
}

beforeAll(async () => {
  corpus = makeCorpus()
  process.env.HOME = corpus.home
  process.env.ZSEARCH_HOME = join(corpus.home, ".zsearch-data")
  work = mkdtempSync(join(tmpdir(), "zsearch-review-"))
  log = join(work, "embed.log")
  process.env.FAKE_EMBED_LOG = log
  tool = join(work, "fake-embed")
  writeFileSync(tool, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "helpers", "fake-embed.ts")}" "$@"\n`)
  chmodSync(tool, 0o755)
  corpus.write("notes/garage.txt", "My sedan needs new tyres before winter.\n")
  corpus.write("notes/pets.md", "# Pets\n\nOur puppy chewed the sofa again.\n")
  dbPath = join(corpus.home, ".zsearch-data", "index.db")
  db = openDb(dbPath)
  config = { ...homeConfig(), semantic: { enabled: true, declined: false, code: false } }
  await index()
  expect((await semantic()).status).toBe("done")
})

afterAll(() => {
  db.close()
  corpus.cleanup()
  rmSync(work, { recursive: true, force: true })
  delete process.env.FAKE_EMBED_LOG
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v
})

describe("grouped queries and sorting", () => {
  test("an outer limit applies after the parts of a group are combined", async () => {
    corpus.write("notes/zqalpha.txt", "zqalpha\n")
    corpus.write("notes/zqgamma.txt", "zqgamma\n")
    await index()
    const e = new SearchEngine(db, config)
    const all = await e.search("(zqalpha OR zqgamma) ext:txt", "find")
    expect(names(all).sort()).toEqual(["notes/zqalpha.txt", "notes/zqgamma.txt"])
    const one = await e.search("(zqalpha OR zqgamma) ext:txt limit:1", "find")
    expect(one.hits).toHaveLength(1)
    expect(["notes/zqalpha.txt", "notes/zqgamma.txt"]).toContain(one.hits[0]!.display)
    expect(one.total).toBe(2)
    expect(one.partial).toBe(false)
  })

  test("fuzzy results are sorted before they are cut to the limit", async () => {
    corpus.write("notes/qzvw.txt", "x")
    corpus.write("notes/q-z-v-w-larger.txt", "thirty-five bytes of filler text..\n")
    await index()
    const e = new SearchEngine(db, config)
    const top = await e.search("qzvw sort:-size limit:1", "fuzzy")
    expect(names(top)).toEqual(["notes/q-z-v-w-larger.txt"])
    // Highlights are worked out for the hits shown.
    expect(top.hits[0]!.namePositions).toHaveLength(4)
    const more = await e.search("qzvw sort:-size limit:10", "fuzzy")
    expect(names(more)[0]).toBe("notes/q-z-v-w-larger.txt")
  })
})

describe("semantic authorization", () => {
  test("negated words only consult text the user may read", async () => {
    const secret = join(corpus.home, "secret")
    corpus.write("secret/budget-plan.txt", "The budget figures mention confidentialword twice: confidentialword.\n")
    await index()
    try {
      for (const c of [{ ...config, namesOnly: [secret] }, { ...config, content: { ...config.content, enabled: false } }]) {
        const e = new SearchEngine(db, c)
        e.embedQuery = null
        const hidden = names(await e.search("budget -confidentialword", "semantic"))
        const absent = names(await e.search("budget -absentword", "semantic"))
        expect(absent).toContain("secret/budget-plan.txt")
        expect(hidden).toContain("secret/budget-plan.txt")
      }
      // Readable text still rules a file out.
      const open = new SearchEngine(db, config)
      open.embedQuery = null
      expect(names(await open.search("budget -confidentialword", "semantic"))).not.toContain("secret/budget-plan.txt")
    } finally {
      rmSync(secret, { recursive: true, force: true })
      await index()
    }
  })

  test("restricted passages don't set the scale of visible files' meaning scores", async () => {
    const restricted = join(corpus.home, "restricted")
    const scoresWith = async (text: string) => {
      for (let i = 0; i < 10; i++) corpus.write(`restricted/r${i}.txt`, `${text} ${i}\n`)
      await index()
      expect((await semantic()).status).toBe("done")
      const e = engine({ ...config, namesOnly: [restricted] })
      const r = await e.search("canine", "semantic")
      e.closeSemantic()
      expect(r.hits.some((h) => h.display.startsWith("restricted/"))).toBe(false)
      return Object.fromEntries(r.hits.map((h) => [h.display, h.score]))
    }
    try {
      const unrelated = await scoresWith("Invoice payment receipt for the bill")
      const related = await scoresWith("The puppy and the dog and the canine")
      expect(unrelated["notes/pets.md"]).toBeGreaterThan(0)
      expect(Object.keys(related).sort()).toEqual(Object.keys(unrelated).sort())
      for (const [file, score] of Object.entries(unrelated)) expect(related[file]).toBeCloseTo(score, 9)
    } finally {
      rmSync(restricted, { recursive: true, force: true })
      await index()
      expect((await semantic()).status).toBe("done")
    }
  })
})

describe("semantic snapshots", () => {
  test("a renamed file is embedded again under its new title", async () => {
    const before = corpus.write("notes/sedan.txt", "It needs new tyres before winter, said the mechanic.\n")
    await index()
    expect((await semantic()).status).toBe("done")
    const id = (db.query("SELECT id FROM files WHERE path = ?").get(before) as { id: number }).id
    const after = join(corpus.home, "notes/puppy.txt")
    renameSync(before, after)
    await index()
    try {
      expect((db.query("SELECT id FROM files WHERE path = ?").get(after) as { id: number } | null)?.id).toBe(id)
      rmSync(log, { force: true })
      const r = await semantic()
      expect(r.status).toBe("done")
      expect(r.embedded).toBe(1)
      expect(embeddedTexts()).toEqual(["puppy\n\nIt needs new tyres before winter, said the mechanic."])
    } finally {
      rmSync(after, { force: true })
      await index()
      expect((await semantic()).status).toBe("done")
    }
  })

  test("vectors made by another model or helper are not searched", async () => {
    const models = join(work, "models")
    mkdirSync(models, { recursive: true })
    writeFileSync(join(models, GRANITE.files[0]!.name), "test model")
    process.env.ZSEARCH_MODELS = models
    process.env.ZSEARCH_EMBED = tool
    const store = openSemanticDb(semanticDbPath(dbPath))!
    // The real query path: the helper's own version decides which stored vectors compare.
    const e = new SearchEngine(db, config)
    try {
      const ok = await e.search("automobile", "semantic")
      expect(ok.strategy).toBe("semantic + words")
      expect(names(ok)[0]).toBe("notes/garage.txt")
      setMeta(store, "fingerprint", semanticFingerprint(0))
      const other = await e.search("automobile", "semantic")
      expect(other.strategy).toBe("words")
      expect(other.notice).toContain("Granite is not ready")
    } finally {
      e.closeSemantic()
      setMeta(store, "fingerprint", semanticFingerprint(1))
      store.close()
      if (env.ZSEARCH_MODELS === undefined) delete process.env.ZSEARCH_MODELS; else process.env.ZSEARCH_MODELS = env.ZSEARCH_MODELS
      if (env.ZSEARCH_EMBED === undefined) delete process.env.ZSEARCH_EMBED; else process.env.ZSEARCH_EMBED = env.ZSEARCH_EMBED
    }
    expect((await engine().search("automobile", "semantic")).strategy).toBe("semantic + words")
  })

  test("a helper whose version can't be read is not started for every search", async () => {
    const models = join(work, "models")
    mkdirSync(models, { recursive: true })
    writeFileSync(join(models, GRANITE.files[0]!.name), "test model")
    const runs = join(work, "version-runs")
    const mute = join(work, "mute-embed")
    writeFileSync(mute, `#!/bin/sh\necho run >> "${runs}"\nexit 1\n`)
    chmodSync(mute, 0o755)
    process.env.ZSEARCH_MODELS = models
    process.env.ZSEARCH_EMBED = mute
    const e = new SearchEngine(db, config)
    try {
      for (let i = 0; i < 3; i++) {
        const r = await e.search("automobile", "semantic")
        expect(r.strategy).toBe("words")
        expect(r.notice).toContain("could not read the embedding helper's version")
      }
      expect(readFileSync(runs, "utf8").trim().split("\n")).toHaveLength(1)
    } finally {
      e.closeSemantic()
      if (env.ZSEARCH_MODELS === undefined) delete process.env.ZSEARCH_MODELS; else process.env.ZSEARCH_MODELS = env.ZSEARCH_MODELS
      if (env.ZSEARCH_EMBED === undefined) delete process.env.ZSEARCH_EMBED; else process.env.ZSEARCH_EMBED = env.ZSEARCH_EMBED
    }
  })

  test("an index update during the query's embedding drops the outdated snapshot", async () => {
    const p = corpus.write("notes/dogwalk.txt", "Our puppy needs a long walk every morning.\n")
    await index()
    expect((await semantic()).status).toBe("done")
    const e = engine()
    let answer!: () => void
    e.embedQuery = async (text) => { await new Promise<void>((r) => { answer = r }); return fakeVector(text) }
    const pending = e.search("canine", "semantic")
    // The same connection: the engine sees no data_version change, only the new change sequence.
    writeFileSync(p, "Quarterly revenue grew by twelve percent.\n")
    await index()
    answer()
    const r = await pending
    e.closeSemantic()
    try {
      expect(r.strategy).toBe("words")
      expect(r.notice).toContain("Granite is not ready")
      expect(names(r)).not.toContain("notes/dogwalk.txt")
      expect(r.hits.flatMap((h) => h.lines).some((l) => l.text.includes("revenue"))).toBe(false)
    } finally {
      rmSync(p, { force: true })
      await index()
      expect((await semantic()).status).toBe("done")
    }
  })
})
