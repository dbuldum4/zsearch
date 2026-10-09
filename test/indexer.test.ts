import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { mkdirSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Config } from "../src/config.ts"
import { ContentState, decompressText, indexStats, openDb, readContent, compressText } from "../src/index/db.ts"
import { crawl } from "../src/index/crawler.ts"
import { crawlOptionsFor, Indexer, type IndexProgress } from "../src/index/indexer.ts"
import { acquireLock, lockHolder } from "../src/index/lock.ts"
import { makeCorpus, homeConfig } from "./helpers/corpus.ts"

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

function paths(db: Database): string[] {
  return (db.query("SELECT path FROM files ORDER BY path").all() as { path: string }[]).map((r) => r.path.slice(corpus.home.length + 1))
}

async function index(db: Database, config: Config = homeConfig(), onProgress?: (p: IndexProgress) => void) {
  return new Indexer(db, config, { inProcess: true, onProgress }).run()
}

function ftsCount(db: Database, q: string): number {
  return (db.query("SELECT count(*) AS n FROM fts WHERE fts MATCH ?").get(q) as { n: number }).n
}

describe("crawler", () => {
  test("respects hidden files, skip lists and .gitignore", () => {
    const opts = crawlOptionsFor(homeConfig())
    const found = [...crawl(opts)].map((e) => e.path.slice(corpus.home.length + 1))
    expect(found).toContain("notes/todo.md")
    expect(found).toContain("code/app/src/server.ts")
    expect(found).not.toContain("code/app/dist/bundle.js") // .gitignore
    expect(found).not.toContain("code/app/debug.log") // .gitignore *.log
    expect(found.some((p) => p.includes("node_modules"))).toBe(false)
    expect(found.some((p) => p.includes(".config"))).toBe(false) // hidden
    expect(found.some((p) => p.includes(".zsearch-data"))).toBe(false) // our own data
  })

  test("hidden files and gitignored files can be included", () => {
    const c = homeConfig()
    c.includeHidden = true
    c.respectGitignore = false
    const found = [...crawl(crawlOptionsFor(c))].map((e) => e.path.slice(corpus.home.length + 1))
    expect(found).toContain(".config/secret.conf")
    expect(found).toContain("code/app/dist/bundle.js")
    expect(found.some((p) => p.includes("node_modules"))).toBe(false) // always skipped
  })

  test("user exclude patterns and absolute excludes", () => {
    const c = homeConfig()
    c.exclude = ["*.md", "~/Downloads"]
    const found = [...crawl(crawlOptionsFor(c))].map((e) => e.path.slice(corpus.home.length + 1))
    expect(found.some((p) => p.endsWith(".md"))).toBe(false)
    expect(found.some((p) => p.startsWith("Downloads"))).toBe(false)
    expect(found).toContain("notes/recipes/pancakes.txt")
  })

  test("symlinked folders are not followed by default, and loops are safe when they are", () => {
    const loop = join(corpus.home, "notes", "loop")
    symlinkSync(join(corpus.home, "notes"), loop)
    try {
      const plain = [...crawl(crawlOptionsFor(homeConfig()))].map((e) => e.path)
      expect(plain.some((p) => p.includes("/loop/"))).toBe(false)
      const c = homeConfig()
      c.followSymlinks = true
      const followed = [...crawl(crawlOptionsFor(c))].map((e) => e.path)
      expect(followed.filter((p) => p.endsWith("/todo.md")).length).toBeLessThanOrEqual(2)
    } finally {
      rmSync(loop)
    }
  })
})

describe("indexer", () => {
  let db: Database

  beforeAll(() => {
    db = openDb(join(corpus.home, ".zsearch-data", "index.db"))
  })

  test("first run indexes names and contents", async () => {
    const phases: string[] = []
    const r = await index(db, homeConfig(), (p) => {
      if (phases[phases.length - 1] !== p.phase) phases.push(p.phase)
    })
    expect(r.phase).toBe("done")
    expect(phases).toEqual(expect.arrayContaining(["scan", "content", "done"]))
    expect(r.added).toBeGreaterThan(30)
    const all = paths(db)
    expect(all).toContain("Documents/report.docx")
    expect(all).toContain("Pictures/holiday-beach.jpg")
    expect(all).toContain("notes") // folders too
    const s = indexStats(db)
    expect(s.withContent).toBeGreaterThanOrEqual(20)
    expect(s.errors).toBe(0)
    expect(s.pending).toBe(0)
    expect(ftsCount(db, "photosynthesis")).toBe(1)
    expect(ftsCount(db, '"twelve percent"')).toBe(1)
    expect(ftsCount(db, "name : holiday")).toBe(1) // media files are searchable by name
  })

  test("content is stored and readable", () => {
    const row = db.query("SELECT id FROM files WHERE path LIKE '%/pancakes.txt'").get() as { id: number }
    expect(readContent(db, row.id)).toContain("pinch of salt")
  })

  test("second run with no changes does nothing", async () => {
    const r = await index(db)
    expect([r.added, r.updated, r.removed, r.contentTotal]).toEqual([0, 0, 0, 0])
  })

  test("modified, added, deleted and renamed files are picked up", async () => {
    const todo = join(corpus.home, "notes", "todo.md")
    writeFileSync(todo, "# Todo\n\n- book tickets to Kyoto\n")
    utimesSync(todo, new Date(), new Date(Date.now() + 5000))
    corpus.write("notes/new-idea.txt", "an idea about solar sailing")
    rmSync(join(corpus.home, "notes", "journal-2024.md"))
    renameSync(join(corpus.home, "notes", "recipes", "pancakes.txt"), join(corpus.home, "notes", "recipes", "crepes.txt"))
    const r = await index(db)
    expect(r.updated).toBe(3) // todo.md plus the two folders whose listing changed
    expect(r.contentTotal).toBe(3) // only todo, new-idea and crepes are re-read
    expect(r.added).toBe(2) // new-idea + crepes
    expect(r.removed).toBe(2) // journal + pancakes
    expect(ftsCount(db, "kyoto")).toBe(1)
    expect(ftsCount(db, "lisbon")).toBe(0)
    expect(ftsCount(db, "solar")).toBe(1)
    expect(ftsCount(db, "glacier")).toBe(0)
    expect(ftsCount(db, "flour")).toBe(1)
    expect(paths(db)).toContain("notes/recipes/crepes.txt")
    expect(paths(db)).not.toContain("notes/recipes/pancakes.txt")
    expect((db.query("SELECT count(*) AS n FROM content WHERE id NOT IN (SELECT id FROM files)").get() as { n: number }).n).toBe(0)
    expect(() => db.exec("INSERT INTO fts(fts, rank) VALUES('integrity-check', 0)")).not.toThrow()
  })

  test("unreadable documents are recorded as errors, not fatal", async () => {
    corpus.write("Documents/broken.docx", "not really a docx")
    const r = await index(db)
    expect(r.phase).toBe("done")
    expect(r.contentErrors).toBe(1)
    const row = db.query("SELECT content_state, note FROM files WHERE path LIKE '%/broken.docx'").get() as { content_state: number; note: string }
    expect(row.content_state).toBe(ContentState.Error)
    expect(row.note).toContain("not a valid Office file")
    // ...and are not retried until they change
    expect((await index(db)).contentTotal).toBe(0)
  })

  test("turning content off keeps names but drops texts", async () => {
    const c = homeConfig()
    c.content.enabled = false
    await index(db, c)
    expect(ftsCount(db, "photosynthesis")).toBe(0)
    expect(paths(db)).toContain("Documents/paper.pdf")
    expect(indexStats(db).withContent).toBe(0)
    await index(db) // and back on
    expect(ftsCount(db, "photosynthesis")).toBe(1)
  })

  test("names-only folders", async () => {
    const c = homeConfig()
    c.namesOnly = ["~/Documents"]
    await index(db, c)
    expect(ftsCount(db, "photosynthesis")).toBe(0)
    expect(ftsCount(db, "kyoto")).toBe(1)
    await index(db)
  })

  test("changing roots removes files outside them", async () => {
    const c = homeConfig()
    c.roots = ["~/notes"]
    const r = await index(db, c)
    expect(r.removed).toBeGreaterThan(10)
    expect(paths(db).every((p) => p.startsWith("notes"))).toBe(true)
    await index(db)
    expect(paths(db)).toContain("Documents/report.docx")
  })

  test("online-only (sparse) files are indexed by name, never read", async () => {
    const p = corpus.write("Documents/cloud-placeholder.txt", "")
    truncateSync(p, 2 * 1024 * 1024) // sparse: no blocks on disk, like an iCloud/Dropbox placeholder
    await index(db)
    const row = db.query("SELECT content_state FROM files WHERE path = ?").get(p) as { content_state: number }
    expect(row.content_state).toBe(ContentState.None)
  })

  test("cancellation leaves a usable index", async () => {
    const controller = new AbortController()
    controller.abort()
    const r = await new Indexer(db, homeConfig(), { inProcess: true, signal: controller.signal }).run()
    expect(r.phase).toBe("cancelled")
    expect(ftsCount(db, "kyoto")).toBe(1)
  })

  test("worker-thread extraction gives the same result", async () => {
    const other = openDb(join(corpus.home, ".zsearch-data", "workers.db"))
    const r = await new Indexer(other, homeConfig()).run()
    expect(r.phase).toBe("done")
    expect(indexStats(other).withContent).toBe(indexStats(db).withContent)
    other.close()
  })

  afterAll(() => db.close())
})

describe("classic FTS delete protocol (older SQLite)", () => {
  test("updates and deletions keep the index consistent", async () => {
    const db = openDb(join(corpus.home, ".zsearch-data", "manual.db"), { manualFtsDelete: true })
    await index(db)
    corpus.write("notes/todo.md", "# Todo\n\n- water the plants\n")
    utimesSync(join(corpus.home, "notes", "todo.md"), new Date(), new Date(Date.now() + 10_000))
    corpus.write("notes/temp.txt", "temporary walrus")
    await index(db)
    expect(ftsCount(db, "walrus")).toBe(1)
    rmSync(join(corpus.home, "notes", "temp.txt"))
    await index(db)
    expect(ftsCount(db, "walrus")).toBe(0)
    expect(ftsCount(db, "plants")).toBe(1)
    expect(ftsCount(db, "kyoto")).toBe(0)
    expect(() => db.exec("INSERT INTO fts(fts, rank) VALUES('integrity-check', 0)")).not.toThrow()
    db.close()
  })
})

describe("storage helpers", () => {
  test("text compression round trip for small and large texts", () => {
    for (const t of ["", "short", "x".repeat(100_000) + "é"]) expect(decompressText(compressText(t))).toBe(t)
    expect(compressText("x".repeat(100_000)).length).toBeLessThan(1000)
  })

  test("index lock", () => {
    const lock = join(corpus.home, ".zsearch-data", "test.lock")
    const release = acquireLock(lock)!
    expect(release).toBeFunction()
    expect(lockHolder(lock)).toBe(process.pid)
    expect(acquireLock(lock)).toBeNull()
    release()
    expect(lockHolder(lock)).toBeNull()
    // stale lock from a dead process
    mkdirSync(join(corpus.home, ".zsearch-data"), { recursive: true })
    writeFileSync(lock, "999999")
    const again = acquireLock(lock)
    expect(again).toBeFunction()
    again!()
  })
})
