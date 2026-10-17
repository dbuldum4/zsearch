import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { join } from "node:path"
import { type Config, paths } from "../src/config.ts"
import { openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { acquireLock } from "../src/index/lock.ts"
import { explainDiagnosis } from "../src/search/diagnose.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { parseQuery, withoutFilters, type Mode } from "../src/search/query.ts"
import { homeConfig, makeCorpus } from "./helpers/corpus.ts"

let corpus: ReturnType<typeof makeCorpus>
let db: Database
let engine: SearchEngine
let config: Config
const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME }

beforeAll(async () => {
  corpus = makeCorpus()
  process.env.HOME = corpus.home
  process.env.ZSEARCH_HOME = join(corpus.home, ".zsearch-data")
  db = openDb(paths().db)
  config = homeConfig()
  await new Indexer(db, config, { inProcess: true }).run()
  engine = new SearchEngine(db, config)
})

afterAll(() => {
  db.close()
  corpus.cleanup()
  process.env.HOME = env.HOME
  if (env.ZSEARCH_HOME === undefined) delete process.env.ZSEARCH_HOME
  else process.env.ZSEARCH_HOME = env.ZSEARCH_HOME
})

/** Search with other settings for one test. */
async function withConfig<T>(change: Partial<Config>, run: () => Promise<T>): Promise<T> {
  engine.config = { ...config, ...change }
  try { return await run() } finally { engine.config = config }
}

const search = (q: string, mode: Mode = "find") => engine.search(q, mode, { limit: 50 })

describe("withoutFilters", () => {
  test("removes the filters with the given keys and keeps the rest as written", () => {
    expect(withoutFilters("budget type:pdf  after:2024", ["type", "kind", "is", "ext"])).toBe("budget after:2024")
    expect(withoutFilters('budget in:"~/My Folder" ext:pdf', ["in", "dir"])).toBe("budget ext:pdf")
    expect(withoutFilters("re:a  b size:>1mb", ["size"])).toBe("re:a  b")
  })

  test("keeps negated filters and treats globs as name filters", () => {
    expect(withoutFilters("plan -type:pdf type:doc", ["type"])).toBe("plan -type:pdf")
    expect(withoutFilters("plan *.md", ["name"])).toBe("plan")
    expect(parseQuery("plan *.md -in:~/x").filterSpans.map((s) => s.key)).toEqual(["name", "-in"])
  })
})

describe("diagnosis of empty results", () => {
  test("results get none", async () => {
    const r = await search("pancakes")
    expect(r.hits.length).toBeGreaterThan(0)
    expect(r.diagnosis).toBeUndefined()
  })

  test("names the filter that leaves everything out, with the query and count without it", async () => {
    const r = await search("pancakes type:pdf")
    expect(r.hits).toEqual([])
    expect(r.diagnosis?.filters).toEqual([{ filter: "type", query: "pancakes", count: 1, more: false }])
    const dated = await search("glacier modified:2001")
    expect(dated.diagnosis?.filters?.map((f) => [f.filter, f.query])).toEqual([["date", "glacier"]])
    expect(explainDiagnosis(dated.diagnosis)).toContain("1 result without the date filter: glacier")
  })

  test("only removing every filter helps: says so", async () => {
    const r = await search("glacier size:>10mb type:pdf")
    expect(r.diagnosis?.filters).toEqual([{ filter: "all", query: "glacier", count: 1, more: false }])
  })

  test("a query of filters alone is not offered an empty query", async () => {
    expect((await search("type:pdf size:>10gb")).diagnosis?.filters?.map((f) => [f.filter, f.query])).toEqual([["size", "type:pdf"]])
    expect((await search("size:>10gb")).diagnosis?.filters).toBeUndefined()
  })

  test("folders outside the index, excluded, names only or missing", async () => {
    const outside = await withConfig({ roots: ["~/notes"] }, () => search("budget in:~/Documents"))
    expect(outside.diagnosis?.folders).toEqual([{ path: "~/Documents", reason: "outside" }])
    expect(explainDiagnosis(outside.diagnosis)[0]).toBe("~/Documents is not in the indexed folders")
    // A folder holding the indexed folders is covered by them.
    expect((await withConfig({ roots: ["~/notes"] }, () => search("qqzzyx in:~"))).diagnosis?.folders).toBeUndefined()
    const excluded = await withConfig({ exclude: ["~/code"] }, () => search("getUserName in:~/code"))
    expect(excluded.diagnosis?.folders).toEqual([{ path: "~/code", reason: "excluded" }])
    const namesOnly = await withConfig({ namesOnly: ["~/notes"] }, () => search("flour in:~/notes"))
    expect(namesOnly.diagnosis?.folders).toEqual([{ path: "~/notes", reason: "namesOnly" }])
    expect((await search("flour in:~/nowhere")).diagnosis?.folders).toEqual([{ path: "~/nowhere", reason: "missing" }])
  })

  test("contents off in the settings", async () => {
    const r = await withConfig({ content: { ...config.content, enabled: false } }, () => search("flour"))
    expect(r.diagnosis?.contentsOff).toBe(true)
  })

  test("counts the files the filters allow whose contents could not be read", async () => {
    db.query("UPDATE files SET content_state = 2, note = 'broken' WHERE path LIKE '%/notes/todo.md'").run()
    try {
      expect((await search("qqzzyx ext:md")).diagnosis?.unreadable).toBe(1)
      expect((await search("qqzzyx ext:pdf")).diagnosis?.unreadable).toBeUndefined()
    } finally {
      db.query("UPDATE files SET content_state = 1, note = NULL WHERE path LIKE '%/notes/todo.md'").run()
    }
  })

  test("other modes that find something, and similar words", async () => {
    const r = await search("pancaks")
    expect(r.diagnosis?.modes?.map((m) => m.mode)).toEqual(["fuzzy"])
    expect(r.diagnosis?.modes?.[0]!.count).toBeGreaterThan(0)
    expect(r.diagnosis?.suggestion).toBe("pancakes")
    expect(explainDiagnosis(r.diagnosis)).toContain(`Fuzzy search finds ${r.diagnosis!.modes![0]!.count} ${r.diagnosis!.modes![0]!.count === 1 ? "result" : "results"}`)
    // A query that picks its mode itself means it.
    expect((await search("re:pancaks")).diagnosis?.modes).toBeUndefined()
  })

  test("an index update holding the lock", async () => {
    expect((await search("qqzzyx")).diagnosis?.indexing).toBeUndefined()
    const release = acquireLock(paths().lock)!
    try {
      expect((await search("qqzzyx")).diagnosis?.indexing).toBe(true)
    } finally {
      release()
    }
  })

  test("semantic search whose index is not complete yet", async () => {
    engine.embedQuery = async () => new Float32Array(768)
    try {
      const r = await withConfig({ semantic: { ...config.semantic, enabled: true } }, () => search("qqzzyx", "semantic"))
      expect(r.diagnosis?.semanticPending).toBe(true)
    } finally {
      engine.embedQuery = undefined
    }
  })

  test("a superseded search is not explained, and explaining can be turned off", async () => {
    expect((await engine.search("pancakes type:pdf", "find", { cancelled: () => true })).diagnosis).toBeUndefined()
    expect((await engine.search("pancakes type:pdf", "find", { explain: false })).diagnosis).toBeUndefined()
  })

  test("grouped queries are explained once, for the whole query", async () => {
    const r = await search("(pancakes OR glacier) type:pdf")
    expect(r.hits).toEqual([])
    expect(r.diagnosis?.filters?.map((f) => [f.filter, f.query])).toEqual([["type", "(pancakes OR glacier)"]])
  })
})
