import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getMeta, openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { Catalog } from "../src/search/catalog.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { homeConfig, makeCorpus } from "./helpers/corpus.ts"

/** The catalog's entries, as a sorted list of paths, checked against its id lookup. */
function entries(c: Catalog): string[] {
  const out: string[] = []
  for (let i = 0; i < c.size; i++) {
    expect(c.indexOf(c.ids[i]!)).toBe(i)
    expect(c.lower[i]).toBe(c.display[i]!.toLowerCase())
    out.push(c.paths[i]!)
  }
  return out.sort()
}

describe("catalog", () => {
  let dir: string
  let db: Database
  const add = (path: string, mtime = 0) =>
    Number(db.query("INSERT INTO files(path, name, ext, kind, size, mtime) VALUES (?, ?, 'txt', 'text', 1, ?)").run(path, path.split("/").pop()!, mtime).lastInsertRowid)
  /** As the indexer removes a file: delete the row and log it. */
  const remove = (id: number) => {
    db.query("DELETE FROM files WHERE id = ?").run(id)
    db.query("INSERT INTO removed(id) VALUES (?)").run(id)
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "zsearch-catalog-"))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  afterEach(() => db.close())

  test("an incremental load drops removed files and takes in reused ids", () => {
    db = openDb(join(dir, "a.db"))
    const ids = ["/x/One.txt", "/x/two.txt", "/x/three.txt", "/x/four.txt"].map((p) => add(p))
    const c = new Catalog()
    c.load(db)
    expect(entries(c)).toEqual(["/x/One.txt", "/x/four.txt", "/x/three.txt", "/x/two.txt"])
    // A removal in the middle moves the last entry into its place.
    remove(ids[1]!)
    // Removing the highest id lets SQLite give it to the next new file.
    remove(ids[3]!)
    const reused = add("/x/FIVE.txt")
    expect(reused).toBe(ids[3]!)
    add("/x/six.txt")
    c.load(db, true)
    expect(entries(c)).toEqual(["/x/FIVE.txt", "/x/One.txt", "/x/six.txt", "/x/three.txt"])
    expect(c.paths[c.indexOf(reused)!]).toBe("/x/FIVE.txt")
    expect(c.indexOf(ids[1]!)).toBeUndefined()
    // Nothing new: nothing changes.
    c.load(db, true)
    expect(c.size).toBe(4)
  })

  test("a reader that missed trimmed removals loads everything again", () => {
    db = openDb(join(dir, "b.db"))
    const a = add("/y/a.txt")
    add("/y/b.txt")
    const c = new Catalog()
    c.load(db)
    remove(a)
    db.query("INSERT INTO removed(id) VALUES (?)").run(999_999)
    // The log is trimmed past the catalog's place in it.
    db.exec("DELETE FROM removed WHERE n = (SELECT MIN(n) FROM removed)")
    c.load(db, true)
    expect(entries(c)).toEqual(["/y/b.txt"])
  })

  test("newest() picks the most recent entries that pass, in order", () => {
    db = openDb(join(dir, "c.db"))
    const mtimes = Array.from({ length: 500 }, (_, i) => (i * 7919) % 1000)
    mtimes.forEach((m, i) => add(`/z/f${i}.txt`, m))
    const c = new Catalog()
    c.load(db)
    const keep = (i: number) => c.mtimes[i]! % 3 !== 0
    const all = Array.from({ length: c.size }, (_, i) => i)
      .filter(keep)
      .sort((x, y) => c.mtimes[y]! - c.mtimes[x]!)
    expect(c.newest(25, keep).map((i) => c.mtimes[i])).toEqual(all.slice(0, 25).map((i) => c.mtimes[i]))
    expect(c.newest(0, keep)).toEqual([])
    expect(c.newest(10_000, keep).length).toBe(all.length)
  })
})

describe("engine after an index update", () => {
  let corpus: ReturnType<typeof makeCorpus>
  const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME }

  beforeAll(() => {
    corpus = makeCorpus()
    process.env.HOME = corpus.home
    process.env.ZSEARCH_HOME = join(corpus.home, ".zsearch-data")
  })
  afterAll(() => {
    corpus.cleanup()
    process.env.HOME = env.HOME
    if (env.ZSEARCH_HOME === undefined) delete process.env.ZSEARCH_HOME
    else process.env.ZSEARCH_HOME = env.ZSEARCH_HOME
  })

  test("removed and added files show without reading the whole index again", async () => {
    const file = join(corpus.home, ".zsearch-data", "index.db")
    const writer = openDb(file)
    const config = homeConfig()
    await new Indexer(writer, config, { inProcess: true }).run()
    const engine = new SearchEngine(openDb(file), config)
    const names = async (q: string) => (await engine.search(q, "find")).hits.map((h) => h.display)
    expect(await names("pancakes")).toContain("notes/recipes/pancakes.txt")
    const generation = getMeta(writer, "generation")

    unlinkSync(join(corpus.home, "notes/recipes/pancakes.txt"))
    corpus.write("notes/recipes/waffles.txt", "Waffles\nThe same batter as pancakes, but in an iron.\n")
    await new Indexer(writer, config, { inProcess: true }).run()

    // An update leaves the generation alone: readers follow it incrementally.
    expect(getMeta(writer, "generation")).toBe(generation)
    const found = await names("pancakes")
    expect(found).toContain("notes/recipes/waffles.txt")
    expect(found).not.toContain("notes/recipes/pancakes.txt")
    expect(engine.catalog.size).toBe((writer.query("SELECT count(*) AS n FROM files").get() as { n: number }).n)
    writer.close()
  })
})
