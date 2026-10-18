import { expect, test } from "bun:test"
import { linkSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import { defaultConfig } from "../src/config.ts"
import { openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine } from "../src/search/engine.ts"

async function corpus(files: Record<string, string>, run: (e: SearchEngine, docs: string, reindex: () => Promise<void>) => Promise<void>, links: [string, string][] = []) {
  const root = mkdtempSync(join(tmpdir(), "zsearch-copies-")), docs = join(root, "docs")
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(docs, name, ".."), { recursive: true })
    writeFileSync(join(docs, name), text)
  }
  for (const [from, to] of links) {
    mkdirSync(join(docs, to, ".."), { recursive: true })
    linkSync(join(docs, from), join(docs, to))
  }
  const config = { ...defaultConfig(), roots: [docs], indexLoad: 100 }, db = openDb(join(root, "index.db"))
  const reindex = async () => { await new Indexer(db, config, { inProcess: true }).run() }
  try { await reindex(); await run(new SearchEngine(db, config), docs, reindex) }
  finally { db.close(); rmSync(root, { recursive: true, force: true }) }
}

const names = (paths: { path: string }[] | undefined) => (paths ?? []).map((p) => p.path.slice(p.path.indexOf("/docs/") + 6)).sort()

test("identical copies fold into one result that lists the others", async () => corpus({
  "a/report.txt": "quokka budget 2024",
  "b/report.txt": "quokka budget 2024",
  "c/report copy.txt": "quokka budget 2024",
  "d/other.txt": "quokka budget 2025",
  "e/note.txt": "quokka elsewhere",
}, async (e) => {
  const grouped = await e.search("quokka", "find", { groupDuplicates: true })
  expect(grouped.hits).toHaveLength(3)
  const group = grouped.hits.find((h) => h.copies)!
  expect(names([group, ...group.copies!])).toEqual(["a/report.txt", "b/report.txt", "c/report copy.txt"])
  expect(group.copies!.every((c) => c.id !== group.id && c.display.endsWith(basename(c.path)) && c.mtime > 0)).toBe(true)
  // Same size, different bytes: kept apart.
  expect(grouped.hits.find((h) => h.path.endsWith("other.txt"))?.copies).toBeUndefined()
  expect(grouped.total).toBe(3)
  // Off unless asked for: every file is a result of its own.
  const plain = await e.search("quokka")
  expect(plain.hits).toHaveLength(5)
  expect(plain.hits.some((h) => h.copies)).toBe(false)
  expect((await e.search("quokka", "find", { groupDuplicates: false })).hits).toHaveLength(5)
  // A group counts once towards the limit.
  const two = await e.search("quokka", "find", { groupDuplicates: true, limit: 2 })
  expect(two.hits).toHaveLength(2)
  expect(two.hits.some((h) => h.copies?.length === 2)).toBe(true)
  expect((await e.search("quokka limit:2", "find", { groupDuplicates: true })).hits).toHaveLength(2)
}))

test("hard links group by inode; a deleted copy leaves its group", async () => corpus({
  "one/data.csv": "wombat,1\nwombat,2\n",
  "two/data.csv": "wombat,1\nwombat,2\n",
}, async (e, docs, reindex) => {
  let hits = (await e.search("wombat", "find", { groupDuplicates: true })).hits
  expect(hits).toHaveLength(1)
  expect(names([hits[0]!, ...hits[0]!.copies!])).toEqual(["linked/data.csv", "one/data.csv", "two/data.csv"])
  // Names-only files are not read: a hard link still groups by inode, a copy does not.
  e.config.namesOnly = [join(docs, "one"), join(docs, "linked")]
  hits = (await e.search("data.csv", "find", { groupDuplicates: true })).hits
  expect(hits.map((h) => [h, ...(h.copies ?? [])].length).sort()).toEqual([1, 2])
  e.config.namesOnly = []
  unlinkSync(join(docs, "two/data.csv"))
  // Before the index hears of it, and after.
  for (const update of [async () => {}, reindex]) {
    await update()
    hits = (await e.search("wombat", "find", { groupDuplicates: true })).hits
    expect(hits).toHaveLength(1)
    expect(names([hits[0]!, ...hits[0]!.copies!])).toEqual(["linked/data.csv", "one/data.csv"])
  }
}, [["one/data.csv", "linked/data.csv"]]))

test("a copy changed on disk is compared again", async () => corpus({
  "x/plan.md": "numbat plan",
  "y/plan.md": "numbat plan",
}, async (e, docs) => {
  expect((await e.search("numbat", "find", { groupDuplicates: true })).hits).toHaveLength(1)
  writeFileSync(join(docs, "y/plan.md"), "numbat plaN")
  expect((await e.search("numbat", "find", { groupDuplicates: true })).hits).toHaveLength(2)
}))
