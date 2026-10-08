import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type Config, defaultConfig } from "../src/config.ts"
import { indexStats, openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { chunkText } from "../src/semantic/chunk.ts"
import { createEmbedder, downloadModel2Vec, embedderId, model2vecDir, model2vecInstalled } from "../src/semantic/embedder.ts"
import { Model2Vec, parseSafetensors, readTensor } from "../src/semantic/model2vec.ts"
import { decodeVector, encodeVector, normalize, VectorStore } from "../src/semantic/vectors.ts"
import { makeCorpus } from "./helpers/corpus.ts"
import { writeTestModel } from "./helpers/model.ts"

let corpus: ReturnType<typeof makeCorpus>
let modelDir: string
const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME, HF_ENDPOINT: process.env.HF_ENDPOINT }

beforeAll(() => {
  corpus = makeCorpus()
  process.env.HOME = corpus.home
  process.env.ZSEARCH_HOME = join(corpus.home, ".zsearch-data")
  modelDir = writeTestModel(join(corpus.home, ".zsearch-data", "test-model"))
})

afterAll(() => {
  corpus.cleanup()
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("chunking", () => {
  test("short text is one chunk", () => {
    expect(chunkText("A short note about budgets.")).toEqual([{ start: 0, end: 27 }])
  })

  test("long text splits on paragraph and sentence boundaries with overlap", () => {
    const para = "This sentence talks about the quarterly budget review. ".repeat(12)
    const text = `${para}\n\n${para}\n\n${para}`
    const chunks = chunkText(text, { target: 400, max: 600, overlap: 60 })
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) {
      expect(c.end - c.start).toBeLessThanOrEqual(600)
      expect(text.slice(c.end - 2, c.end)).toMatch(/\.\s|\s\s|\n\n|\. $/)
    }
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBeLessThan(chunks[i - 1]!.end)
  })

  test("very long documents are sampled down to maxChunks", () => {
    const text = "word ".repeat(200_000)
    const chunks = chunkText(text, { maxChunks: 10 })
    expect(chunks).toHaveLength(10)
    expect(chunks[9]!.start).toBeGreaterThan(text.length / 2)
  })

  test("whitespace-only text has no chunks", () => {
    expect(chunkText("   \n\n  ")).toEqual([])
  })
})

describe("vectors", () => {
  test("int8 encoding keeps cosine similarity", () => {
    const a = normalize(Float32Array.from([0.1, 0.9, -0.3, 0.2]))
    const { scale, q } = decodeVector(encodeVector(a))
    let dot = 0
    for (let i = 0; i < a.length; i++) dot += a[i]! * q[i]! * scale
    expect(dot).toBeCloseTo(1, 2)
  })

  test("brute-force store returns the nearest chunks and honours filters", () => {
    const store = new VectorStore()
    const vecs = [
      [1, 0, 0],
      [0, 1, 0],
      [0.7, 0.7, 0],
      [0, 0, 1],
    ].map((v) => encodeVector(normalize(Float32Array.from(v))))
    vecs.forEach((v, i) => store.add(i + 1, i * 10, i * 10 + 5, v))
    const q = normalize(Float32Array.from([1, 0.1, 0]))
    expect(store.search(q, 2).map((r) => store.fileIds[r.idx])).toEqual([1, 3])
    expect(store.search(q, 2, (id) => id !== 1).map((r) => store.fileIds[r.idx])).toEqual([3, 2])
  })
})

describe("model2vec", () => {
  test("loads the model and embeds with mean pooling", () => {
    const m = Model2Vec.load(modelDir)
    const cos = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0)
    const q = m.embedOne("money and spending")
    expect(cos(q, m.embedOne("quarterly budget revenue"))).toBeGreaterThan(0.8)
    expect(cos(q, m.embedOne("flour eggs butter"))).toBeLessThan(0.3)
    // Unknown words only: zero vector, no crash.
    expect([...m.embedOne("qwxz zzkq")].every((x) => x === 0)).toBe(true)
  })

  test("safetensors: float16 tensors", () => {
    const header = JSON.stringify({ t: { dtype: "F16", shape: [2], data_offsets: [0, 4] }, __metadata__: { a: "b" } })
    const buf = new Uint8Array(8 + header.length + 4)
    new DataView(buf.buffer).setBigUint64(0, BigInt(header.length), true)
    buf.set(new TextEncoder().encode(header), 8)
    new DataView(buf.buffer).setUint16(8 + header.length, 0x3c00, true) // 1.0
    new DataView(buf.buffer).setUint16(8 + header.length + 2, 0xc000, true) // -2.0
    const st = parseSafetensors(buf)
    expect([...readTensor(st, "t")!.f32!]).toEqual([1, -2])
    expect(readTensor(st, "missing")).toBeNull()
  })

  test("a local folder can be used as the model", async () => {
    expect(model2vecDir(modelDir)).toBe(modelDir)
    expect(model2vecInstalled(modelDir)).toBe(true)
    const e = await createEmbedder({ ...defaultConfig().semantic, enabled: true, model: modelDir })
    expect(e.id).toBe(`model2vec:${modelDir}`)
    expect((await e.embedQuery("budget")).length).toBe(e.dims)
  })

  test("downloads from a Hugging Face-compatible endpoint with progress", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const m = /^\/acme\/tiny-model\/resolve\/main\/(.+)$/.exec(new URL(req.url).pathname)
        if (!m || !existsSync(join(modelDir, m[1]!))) return new Response("not found", { status: 404 })
        return new Response(readFileSync(join(modelDir, m[1]!)))
      },
    })
    process.env.HF_ENDPOINT = `http://localhost:${server.port}`
    try {
      const seen = new Set<string>()
      const dir = await downloadModel2Vec("acme/tiny-model", (file) => seen.add(file))
      expect(dir).toBe(join(process.env.ZSEARCH_HOME!, "cache", "models", "acme--tiny-model"))
      expect(model2vecInstalled("acme/tiny-model")).toBe(true)
      expect([...seen].sort()).toEqual(["config.json", "model.safetensors", "tokenizer.json"])
      await expect(downloadModel2Vec("acme/missing-model")).rejects.toThrow(/HTTP 404/)
      expect(existsSync(join(model2vecDir("acme/missing-model"), "config.json.part"))).toBe(false)
    } finally {
      server.stop(true)
      delete process.env.HF_ENDPOINT
    }
  })

  test("a missing model is not downloaded when downloads are disabled", async () => {
    await expect(createEmbedder({ ...defaultConfig().semantic, model: "acme/not-there" }, { download: false })).rejects.toThrow(/not downloaded/)
  })
})

describe("HTTP embedding providers", () => {
  const calls: { path: string; body: { model: string; input: string[] }; auth: string | null }[] = []
  let server: ReturnType<typeof Bun.serve>
  const vec = (s: string) => (s.includes("budget") || s.includes("money") ? [1, 0, 0] : [0, 1, 0])

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        const body = (await req.json()) as { model: string; input: string[] }
        calls.push({ path, body, auth: req.headers.get("authorization") })
        if (path === "/api/embed") return Response.json({ embeddings: body.input.map(vec) })
        if (path === "/v1/embeddings") return Response.json({ data: body.input.map((s, index) => ({ index, embedding: vec(s) })).reverse() })
        return new Response("nope", { status: 404 })
      },
    })
  })
  afterAll(() => server.stop(true))

  test("ollama", async () => {
    const e = await createEmbedder({ ...defaultConfig().semantic, provider: "ollama", model: "nomic-embed-text", url: `http://localhost:${server.port}` })
    expect(e.id).toBe("ollama:nomic-embed-text")
    const [a, b] = await e.embedDocuments(["budget report", "pancakes"])
    expect([...a!]).toEqual([1, 0, 0])
    expect([...b!]).toEqual([0, 1, 0])
    const last = calls[calls.length - 1]!
    expect(last.path).toBe("/api/embed")
    expect(last.body.input[0]).toBe("search_document: budget report") // nomic prefixes
  })

  test("openai-compatible with API key and index ordering", async () => {
    process.env.ZS_TEST_KEY = "sk-test"
    try {
      const e = await createEmbedder({ ...defaultConfig().semantic, provider: "openai", model: "text-embedding-3-small", url: `http://localhost:${server.port}/v1`, apiKeyEnv: "ZS_TEST_KEY" })
      const out = await e.embedDocuments(["money", "pancakes"])
      expect([...out[0]!]).toEqual([1, 0, 0])
      expect([...out[1]!]).toEqual([0, 1, 0])
      expect(calls[calls.length - 1]!.auth).toBe("Bearer sk-test")
    } finally {
      delete process.env.ZS_TEST_KEY
    }
  })

  test("unreachable provider gives a clear error", async () => {
    await expect(createEmbedder({ ...defaultConfig().semantic, provider: "ollama", url: "http://127.0.0.1:9" })).rejects.toThrow(/cannot reach ollama/)
  })

  test("embedder ids", () => {
    expect(embedderId({ ...defaultConfig().semantic })).toBe("model2vec:minishlab/potion-base-8M")
    expect(embedderId({ ...defaultConfig().semantic, provider: "ollama", model: "" })).toBe("ollama:nomic-embed-text")
  })
})

describe("semantic failures are not fatal", () => {
  test("an unavailable model leaves names and contents indexed, with a warning", async () => {
    const config = defaultConfig()
    config.semantic.enabled = true
    config.semantic.provider = "ollama"
    config.semantic.url = "http://127.0.0.1:9"
    const db = openDb(join(corpus.home, ".zsearch-data", "nomodel.db"))
    const r = await new Indexer(db, config, { inProcess: true }).run()
    expect(r.phase).toBe("done")
    expect(r.warning).toMatch(/semantic index not built: cannot reach ollama/)
    expect(indexStats(db).withContent).toBeGreaterThan(10)
    expect(indexStats(db).lastIndexedAt).not.toBeNull()
    db.close()
  })
})

describe("semantic search end to end", () => {
  let db: Database
  let engine: SearchEngine
  let config: Config

  beforeAll(async () => {
    config = defaultConfig()
    config.semantic.enabled = true
    config.semantic.model = modelDir
    db = openDb(join(corpus.home, ".zsearch-data", "semantic.db"))
    const r = await new Indexer(db, config, { inProcess: true }).run()
    expect(r.phase).toBe("done")
    expect(r.semanticTotal).toBeGreaterThan(10)
    engine = new SearchEngine(db, config)
  })
  afterAll(() => db.close())

  test("passages are embedded during indexing", () => {
    const s = indexStats(db)
    expect(s.chunks).toBeGreaterThan(10)
    expect(s.semanticModel).toBe(`model2vec:${modelDir}`)
    expect(engine.semanticAvailable()).toBe(true)
  })

  test("finds documents by meaning, without shared words", async () => {
    const r = await engine.search("cooking breakfast", "semantic")
    expect(r.hits[0]!.display).toBe("notes/recipes/pancakes.txt")
    expect(r.hits[0]!.sources).toContain("semantic")
    expect(r.hits[0]!.lines[0]!.text).toContain("flour")
    const money = await engine.search("money spending", "semantic")
    expect(money.hits.slice(0, 3).map((h) => h.display)).toEqual(expect.arrayContaining(["Documents/budget.xlsx"]))
    const space = await engine.search("spacecraft astronaut", "semantic")
    expect(space.hits[0]!.display).toBe("Documents/deck.pptx")
  })

  test("auto mode uses meaning for natural-language questions", async () => {
    const r = await engine.search("what did i write about cooking breakfast", "auto")
    expect(r.strategy).toContain("meaning")
    expect(r.hits.slice(0, 3).map((h) => h.display)).toContain("notes/recipes/pancakes.txt")
  })

  test("semantic results respect filters", async () => {
    const r = await engine.search("money spending type:slides", "semantic")
    expect(r.hits.every((h) => h.kind === "slides")).toBe(true)
  })

  test("re-indexing only embeds changed files; switching models rebuilds vectors", async () => {
    corpus.write("notes/space.txt", "The rocket launch was delayed by thermal vacuum tests.")
    const r = await new Indexer(db, config, { inProcess: true }).run()
    expect(r.semanticTotal).toBe(1)
    const other = writeTestModel(join(corpus.home, ".zsearch-data", "test-model-2"))
    const r2 = await new Indexer(db, { ...config, semantic: { ...config.semantic, model: other } }, { inProcess: true }).run()
    expect(r2.semanticTotal).toBeGreaterThan(10)
  })

  test("a config that does not match the index disables semantic results", async () => {
    const e = new SearchEngine(db, config) // index now holds test-model-2 vectors
    expect(e.semanticAvailable()).toBe(false)
  })
})
