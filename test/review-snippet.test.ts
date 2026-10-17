import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { Catalog } from "../src/search/catalog.ts"
import { SearchEngine } from "../src/search/engine.ts"
import type { Filters } from "../src/search/query.ts"
import { readIndexed } from "../src/search/read.ts"
import { diacriticPattern, findLines } from "../src/search/snippet.ts"
import { homeConfig } from "./helpers/corpus.ts"

test("an empty unicode match steps over a whole surrogate pair", () => {
  expect(findLines("😀", /(?=.)/gu).count).toBe(0)
  expect(findLines("a😀b\n😀", /(?=.)/gu).count).toBe(0)
  // Non-empty matches next to astral characters are still found.
  expect(findLines("😀x😀x", /x|(?=😀)/gu).count).toBe(2)
  // Past the line cap, the count-only loop steps the same way.
  expect(findLines("x\n😀\nx\n😀x", /x|(?=😀)/gu, 1).count).toBe(3)
})

describe("accent classes keep the pattern's case", () => {
  const re = (p: string, flags: string) => new RegExp(diacriticPattern(p), flags)

  test("case-sensitive patterns match only their own case", () => {
    expect(re("BUDGET", "u").test("budget")).toBe(false)
    expect(re("BUDGET", "u").test("büdget")).toBe(false)
    expect(re("BUDGET", "u").test("BÜDGET")).toBe(true)
    expect(re("budget", "u").test("BUDGET")).toBe(false)
    expect(re("budget", "u").test("büdget")).toBe(true)
    expect(re("Café", "u").test("CAFE")).toBe(false)
    expect(re("Café", "u").test("Cafe")).toBe(true)
  })

  test("case-insensitive patterns still match every variant", () => {
    for (const p of ["budget", "BUDGET"]) {
      for (const t of ["budget", "BUDGET", "büdget", "BÜDGET"]) expect(re(p, "iu").test(t)).toBe(true)
    }
    // Variants without a single-letter partner of the other case.
    expect(re("istanbul", "iu").test("İstanbul")).toBe(true)
    expect(re("Y", "iu").test("ẙ")).toBe(true)
  })
})

describe("typo fallback", () => {
  let dir: string
  let db: Database
  const none: Filters = { exts: null, kinds: null, notKinds: null, inPaths: [], pathContains: [] }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "zsearch-typo-"))
    db = openDb(join(dir, "a.db"))
    for (const p of ["/x/app/main.txt", "/x/lib/main.txt", "/x/lib/main.rs"]) {
      db.query("INSERT INTO files(path, name, ext, kind, size, mtime) VALUES (?, ?, 'txt', 'text', 1, 0)").run(p, p.split("/").pop()!)
    }
  })
  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const typo = (q: string) => {
    const c = new Catalog()
    c.load(db)
    return c.typo(q, none, 10).map((m) => c.paths[m.idx]).sort()
  }

  test("keeps exclusions and required operators", () => {
    expect(typo("mian")).toEqual(["/x/app/main.txt", "/x/lib/main.rs", "/x/lib/main.txt"])
    expect(typo("mian !app")).toEqual(["/x/lib/main.rs", "/x/lib/main.txt"])
    expect(typo("mian txt$")).toEqual(["/x/app/main.txt", "/x/lib/main.txt"])
    expect(typo("mian 'lib")).toEqual(["/x/lib/main.rs", "/x/lib/main.txt"])
    expect(typo("mian ^nope")).toEqual([])
  })
})

test("paging matches resumes inside an earlier match's context", async () => {
  const home = mkdtempSync(join(tmpdir(), "zsearch-page-"))
  const dbDir = mkdtempSync(join(tmpdir(), "zsearch-page-db-"))
  const prevHome = process.env.HOME
  process.env.HOME = home
  try {
    const path = join(home, "a.txt")
    writeFileSync(path, "zebra here\nafter it\n\n")
    const db = openDb(join(dbDir, "index.db"))
    const config = homeConfig()
    await new Indexer(db, config, { inProcess: true }).run()
    const engine = new SearchEngine(db, config)
    const opts = { lines: 1, maxChars: 1000, matchesOnly: true, context: 1 }
    const first = readIndexed(engine, path, "zebra", "find", opts)!
    expect(first.lines.map((l) => l.n)).toEqual([1])
    expect(first.next).toEqual({ line: 2, column: 1 })
    const second = readIndexed(engine, path, "zebra", "find", { ...opts, line: 2 })!
    expect(second.lines.map((l) => l.n)).toEqual([2])
    expect(second.next).toBeNull()
    db.close()
  } finally {
    process.env.HOME = prevHome
    rmSync(home, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  }
})
