import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type Config, defaultConfig } from "../src/config.ts"
import { crawl, crawlTargets, type CrawlStats } from "../src/index/crawler.ts"
import { ContentState, getMeta, openDb, readContent } from "../src/index/db.ts"
import { crawlOptionsFor, Indexer } from "../src/index/indexer.ts"

let home: string
let db: Database
const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME }

const at = (rel: string) => join(home, rel)
function write(rel: string, data: string) {
  mkdirSync(dirname(at(rel)), { recursive: true })
  writeFileSync(at(rel), data)
  return at(rel)
}
function config(): Config {
  const c = defaultConfig()
  c.roots = ["~/a", "~/b"]
  c.exclude = ["*.log"]
  c.content = { ...c.content, ocr: false, transcribe: false }
  return c
}
function run(paths?: string[], c = config()) {
  return new Indexer(db, c, { inProcess: true, paths }).run()
}
function row(rel: string) {
  return db.query("SELECT id, content_state AS state, note FROM files WHERE path = ?").get(at(rel)) as { id: number; state: number; note: string | null } | null
}
function indexed(prefix: string): string[] {
  return (db.query("SELECT path FROM files WHERE path = ? OR path LIKE ? ORDER BY path").all(at(prefix), at(prefix) + "/%") as { path: string }[]).map((r) => r.path.slice(home.length + 1))
}
function ftsHits(word: string): number {
  return (db.query("SELECT count(*) AS n FROM fts WHERE fts MATCH ?").get(word) as { n: number }).n
}

beforeAll(async () => {
  home = mkdtempSync(join(process.env.ZSEARCH_TEST_TMP || tmpdir(), "zsearch-live-"))
  process.env.HOME = home
  process.env.ZSEARCH_HOME = join(home, ".zsearch-data")
  write("a/one.txt", "the first note mentions aardvark\n")
  write("a/two.txt", "the second note mentions badger\n")
  write("a/sub/inner.txt", "inner file about capybara\n")
  write("a/sub/deeper/leaf.txt", "leaf file about dingo\n")
  write("a/folder/kept.txt", "kept file about echidna\n")
  write("a/.gitignore", "ignored/\n")
  write("a/proj/build/out.txt", "build output about ferret\n")
  write("a/proj/src/main.txt", "main source about gecko\n")
  for (let i = 0; i < 50; i++) write(`b/many/file-${i}.txt`, `unrelated file number ${i}\n`)
  db = openDb(join(home, ".zsearch-data", "index.db"))
  const first = await run()
  expect(first.phase).toBe("done")
})

afterAll(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
  process.env.HOME = env.HOME
  if (env.ZSEARCH_HOME === undefined) delete process.env.ZSEARCH_HOME
  else process.env.ZSEARCH_HOME = env.ZSEARCH_HOME
})

test("a file event updates new, changed and deleted files without walking the other roots", async () => {
  const lastFull = getMeta(db, "last_indexed_at")
  const before = (db.query("SELECT max(n) AS n FROM removed").get() as { n: number | null }).n ?? 0
  const gone = row("a/two.txt")!.id
  write("a/new.txt", "a brand new note about hedgehog\n")
  write("a/one.txt", "the first note now mentions quokka instead, and is longer\n")
  rmSync(at("a/two.txt"))
  const r = await run([at("a/new.txt"), at("a/one.txt"), at("a/two.txt")])
  expect(r.phase).toBe("done")
  expect(r.added).toBe(1)
  expect(r.updated).toBe(1)
  expect(r.removed).toBe(1)
  // The three files and nothing of ~/b's 50.
  expect(r.scanned).toBeLessThanOrEqual(3)
  expect(row("a/new.txt")?.state).toBe(ContentState.Indexed)
  expect(readContent(db, row("a/one.txt")!.id)).toContain("quokka")
  expect(ftsHits("aardvark")).toBe(0)
  expect(ftsHits("hedgehog")).toBe(1)
  expect(row("a/two.txt")).toBeNull()
  // Readers follow removals from the log.
  expect(db.query("SELECT id FROM removed WHERE n > ?").all(before)).toEqual([{ id: gone }])
  // The timed refresh still goes by the last full walk.
  expect(getMeta(db, "last_indexed_at")).toBe(lastFull)
})

test("only the target subtree is listed", () => {
  const opts = crawlOptionsFor(config())
  const stats: CrawlStats = { dirs: 0, files: 0, errors: 0, skipped: 0 }
  const found = [...crawl(opts, stats, crawlTargets(opts, [at("a/sub")]))].map((e) => e.path.slice(home.length + 1))
  expect(found.sort()).toEqual(["a/sub", "a/sub/deeper", "a/sub/deeper/leaf.txt", "a/sub/inner.txt"])
  expect(stats.dirs).toBe(2)
  const full: CrawlStats = { dirs: 0, files: 0, errors: 0, skipped: 0 }
  for (const _ of crawl(opts, full)) void _
  expect(full.dirs).toBeGreaterThan(stats.dirs + 3)
})

test("a deleted folder takes everything below it", async () => {
  expect(indexed("a/sub").length).toBe(4)
  rmSync(at("a/sub"), { recursive: true })
  // Events may name only something deep inside; the highest folder gone is what goes.
  const r = await run([at("a/sub/deeper/leaf.txt")])
  expect(r.removed).toBe(4)
  expect(indexed("a/sub")).toEqual([])
})

test("a new folder is walked whole, even when events name only part of it", async () => {
  write("a/fresh/nested/named.txt", "named by the event, about ibis\n")
  write("a/fresh/unnamed.txt", "not named by any event, about jackal\n")
  const r = await run([at("a/fresh/nested/named.txt")])
  expect(r.phase).toBe("done")
  expect(indexed("a/fresh")).toEqual(["a/fresh", "a/fresh/nested", "a/fresh/nested/named.txt", "a/fresh/unnamed.txt"])
  expect(ftsHits("jackal")).toBe(1)
})

test("a rename within the roots keeps the extracted text", async () => {
  const file = row("a/new.txt")!.id
  const kept = row("a/folder/kept.txt")!.id
  renameSync(at("a/new.txt"), at("b/moved.txt"))
  renameSync(at("a/folder"), at("a/renamed"))
  const r = await run([at("a/new.txt"), at("b/moved.txt"), at("a/folder"), at("a/renamed")])
  expect(r.phase).toBe("done")
  expect(r.contentTotal).toBe(0)
  expect(row("b/moved.txt")?.id).toBe(file)
  expect(row("a/renamed/kept.txt")?.id).toBe(kept)
  expect(row("a/new.txt")).toBeNull()
  expect(indexed("a/folder")).toEqual([])
  expect(ftsHits("hedgehog")).toBe(1)
})

test("events outside the roots, and excluded, ignored or hidden paths, add nothing", async () => {
  const outside = write("elsewhere/x.txt", "outside the roots\n")
  const excluded = write("a/app.log", "excluded by pattern\n")
  const ignored = write("a/deep/ignored/x.txt", "ignored by the .gitignore of an ancestor folder\n")
  const hidden = write("a/.hidden/x.txt", "hidden\n")
  const r = await run([outside, excluded, ignored, hidden])
  expect(r.phase).toBe("done")
  expect(r.added).toBe(1) // a/deep itself: it holds an ignored folder, but is not ignored
  for (const p of [outside, excluded, ignored, hidden]) expect(db.query("SELECT 1 FROM files WHERE path = ?").get(p)).toBeNull()
})

test("key files found through events keep their text out", async () => {
  write("a/keys/id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n")
  await run([at("a/keys/id_rsa")])
  expect(row("a/keys/id_rsa")?.state).toBe(ContentState.Skipped)
})

test("editing an ignore file walks its folder again", async () => {
  expect(indexed("a/proj/build")).toEqual(["a/proj/build", "a/proj/build/out.txt"])
  write("a/proj/.gitignore", "build/\n")
  let r = await run([at("a/proj/.gitignore")])
  expect(r.removed).toBe(2)
  expect(indexed("a/proj/build")).toEqual([])
  expect(indexed("a/proj/src")).toEqual(["a/proj/src", "a/proj/src/main.txt"])
  write("a/proj/.gitignore", "\n")
  r = await run([at("a/proj/.gitignore")])
  expect(r.added).toBe(2)
  expect(indexed("a/proj/build")).toEqual(["a/proj/build", "a/proj/build/out.txt"])
})

test("changed settings or no finished full walk make an event walk every root", async () => {
  const c = config()
  c.exclude = ["*.log", "many/"]
  const lastFull = getMeta(db, "last_indexed_at")
  await Bun.sleep(5)
  const r = await run([at("a/one.txt")], c)
  expect(r.phase).toBe("done")
  expect(r.removed).toBeGreaterThanOrEqual(50)
  expect(getMeta(db, "last_indexed_at")).not.toBe(lastFull)
  // The walk with the new settings is the one events build on now.
  const after = await run([at("a/one.txt")], c)
  expect(after.scanned).toBe(1)
})

test("event updates leave the index as a full walk finds it", async () => {
  const c = config()
  c.exclude = ["*.log", "many/"]
  write("a/proj/src/added.txt", "added next to main\n")
  write("a/proj/src/main.txt", "main source, edited to be about kiwi\n")
  rmSync(at("a/renamed/kept.txt"))
  write("a/proj/.gitignore", "*.tmp\n")
  write("a/proj/build/scratch.tmp", "scratch\n")
  renameSync(at("a/fresh"), at("b/fresh"))
  await run([at("a/proj/src/added.txt"), at("a/proj/src/main.txt"), at("a/renamed/kept.txt"), at("a/proj/.gitignore"), at("a/proj/build/scratch.tmp"), at("a/fresh"), at("b/fresh")], c)
  const snapshot = () => db.query("SELECT path, is_dir, size, mtime, ino, content_state AS state FROM files ORDER BY path").all()
  const before = snapshot()
  const full = await run(undefined, c)
  expect([full.added, full.updated, full.removed]).toEqual([0, 0, 0])
  expect(snapshot()).toEqual(before)
})
