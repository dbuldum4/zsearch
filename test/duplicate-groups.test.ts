import { expect, test } from "bun:test"
import { linkSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import { defaultConfig } from "../src/config.ts"
import { openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { CopyHashes, type FileOpener } from "../src/search/copy-hashes.ts"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"

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

// Complete-group assertions use a one-shot budget. Typing searches may return before
// filesystem hashing finishes; their short-budget behavior is tested separately below.
const completeGroups = { groupDuplicates: true, budgetMs: 5000 }

const names = (paths: { path: string }[] | undefined) => (paths ?? []).map((p) => p.path.slice(p.path.indexOf("/docs/") + 6)).sort()

test("identical copies fold into one result that lists the others", async () => corpus({
  "a/report.txt": "quokka budget 2024",
  "b/report.txt": "quokka budget 2024",
  "c/report copy.txt": "quokka budget 2024",
  "d/other.txt": "quokka budget 2025",
  "e/note.txt": "quokka elsewhere",
}, async (e) => {
  const grouped = await e.search("quokka", "find", completeGroups)
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
  // A group counts once towards the limit. Fix its rank: filesystem timestamp precision
  // otherwise decides whether the copies or the other two files are newest.
  const two = await e.search("quokka sort:path", "find", { ...completeGroups, limit: 2 })
  expect(two.hits).toHaveLength(2)
  expect(two.hits.some((h) => h.copies?.length === 2)).toBe(true)
  expect((await e.search("quokka limit:2", "find", completeGroups)).hits).toHaveLength(2)
}))

test("hard links group by inode; a deleted copy leaves its group", async () => corpus({
  "one/data.csv": "wombat,1\nwombat,2\n",
  "two/data.csv": "wombat,1\nwombat,2\n",
}, async (e, docs, reindex) => {
  let hits = (await e.search("wombat", "find", completeGroups)).hits
  expect(hits).toHaveLength(1)
  expect(names([hits[0]!, ...hits[0]!.copies!])).toEqual(["linked/data.csv", "one/data.csv", "two/data.csv"])
  // Only one of the links is where contents may not be read: it still groups with the rest.
  e.config.namesOnly = [join(docs, "one")]
  hits = (await e.search("data.csv", "find", completeGroups)).hits
  expect(hits).toHaveLength(1)
  expect(names([hits[0]!, ...hits[0]!.copies!])).toEqual(["linked/data.csv", "one/data.csv", "two/data.csv"])
  // Neither link readable: they group by inode without reading, the unread copy does not.
  e.config.namesOnly = [join(docs, "one"), join(docs, "linked")]
  hits = (await e.search("data.csv", "find", completeGroups)).hits
  expect(hits.map((h) => [h, ...(h.copies ?? [])].length).sort()).toEqual([1, 2])
  e.config.namesOnly = []
  unlinkSync(join(docs, "two/data.csv"))
  // Before the index hears of it, and after.
  for (const update of [async () => {}, reindex]) {
    await update()
    hits = (await e.search("wombat", "find", completeGroups)).hits
    expect(hits).toHaveLength(1)
    expect(names([hits[0]!, ...hits[0]!.copies!])).toEqual(["linked/data.csv", "one/data.csv"])
  }
}, [["one/data.csv", "linked/data.csv"]]))

test("a FIFO in place of a file is not waited on", () => {
  const dir = mkdtempSync(join(tmpdir(), "zsearch-fifo-")), fifo = join(dir, "data.csv")
  try {
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0)
    // In a child process, so that a blocking open fails the test instead of hanging the run.
    const script = `const { fileDigest } = require(${JSON.stringify(join(import.meta.dir, "../src/search/duplicates.ts"))}); console.log(String(fileDigest(${JSON.stringify(fifo)}, { size: 0 })))`
    const child = Bun.spawnSync([process.execPath, "-e", script], { timeout: 10_000 })
    expect(child.stdout.toString().trim()).toBe("null")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a copy changed on disk is compared again", async () => corpus({
  "x/plan.md": "numbat plan",
  "y/plan.md": "numbat plan",
}, async (e, docs) => {
  expect((await e.search("numbat", "find", completeGroups)).hits).toHaveLength(1)
  writeFileSync(join(docs, "y/plan.md"), "numbat plaN")
  expect((await e.search("numbat", "find", completeGroups)).hits).toHaveLength(2)
}))

test("grouped boolean queries fold copies", async () => corpus({
  "p/q.txt": "quokka shared",
  "q/q.txt": "quokka shared",
  "r/w.txt": "wombat solo",
}, async (e) => {
  const hits = (await e.search("quokka OR wombat", "find", completeGroups)).hits
  expect(hits).toHaveLength(2)
  const group = hits.find((h) => h.copies)!
  expect(names([group, ...group.copies!])).toEqual(["p/q.txt", "q/q.txt"])
}))

test("copies past the fetched page are flagged", async () => corpus(
  Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`c${String(i).padStart(2, "0")}/clone.txt`, "quokka clone"])),
  async (e) => {
    const one = await e.search("quokka", "find", { ...completeGroups, limit: 1 })
    expect(one.hits).toHaveLength(1)
    expect(one.hits[0]!.copies).toHaveLength(20)
    expect(one.hits[0]!.copiesMore).toBe(true)
    const all = await e.search("quokka", "find", completeGroups)
    expect(all.hits).toHaveLength(1)
    expect(all.hits[0]!.copies).toHaveLength(24)
    expect(all.hits[0]!.copiesMore).toBeUndefined()
  }))

test("a stalled read does not hold results past the budget; copies group once it answers", async () => {
  const root = mkdtempSync(join(tmpdir(), "zsearch-stall-")), docs = join(root, "docs")
  mkdirSync(join(docs, "a"), { recursive: true })
  writeFileSync(join(docs, "a/slow.dat"), "quokka stalled")
  writeFileSync(join(docs, "slow.dat"), "quokka stalled")
  const config = { ...defaultConfig(), roots: [docs], indexLoad: 100 }, db = openDb(join(root, "index.db"))
  try {
    await new Indexer(db, config, { inProcess: true }).run()
    let hanging = true
    const openFile: FileOpener = async (path) => {
      if (hanging) await new Promise(() => {})
      const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      return {
        stat: () => fh.stat(),
        read: async (buffer, position) => (await fh.read(buffer, 0, buffer.length, position)).bytesRead,
        close: () => fh.close(),
      }
    }
    const e = new SearchEngine(db, config, undefined, undefined, new CopyHashes({ open: openFile, stallMs: 20, retryMs: 0 }))
    const stalled = await e.search("quokka", "find", { groupDuplicates: true })
    // The open never answers: the search returns what it has instead of waiting for it.
    expect(stalled.elapsedMs).toBeLessThan(2000)
    expect(stalled.hits).toHaveLength(2)
    hanging = false
    const unblocked = await e.search("quokka", "find", completeGroups)
    expect(unblocked.hits).toHaveLength(1)
    expect(unblocked.hits[0]!.copies).toHaveLength(1)
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})

test("grouping rechecks exclusions and content policy after hashing yields", async () => {
  const root = mkdtempSync(join(tmpdir(), "zsearch-copy-policy-")), docs = join(root, "docs")
  mkdirSync(join(docs, "a"), { recursive: true })
  writeFileSync(join(docs, "a/quokka.txt"), "quokka confidential")
  writeFileSync(join(docs, "quokka.txt"), "quokka confidential")
  const config = { ...defaultConfig(), roots: [docs], indexLoad: 100 }, db = openDb(join(root, "index.db"))
  try {
    await new Indexer(db, config, { inProcess: true }).run()
    for (const change of ["exclude-all", "exclude-primary", "names-only", "contents-off"] as const) {
      let started!: () => void, resume!: () => void
      const opening = new Promise<void>((resolve) => { started = resolve })
      const gate = new Promise<void>((resolve) => { resume = resolve })
      const hashes = new CopyHashes({ open: async (path) => {
        started()
        await gate
        const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        return {
          stat: () => fh.stat(),
          read: async (buffer, position) => (await fh.read(buffer, 0, buffer.length, position)).bytesRead,
          close: () => fh.close(),
        }
      } })
      const e = new SearchEngine(db, config, undefined, undefined, hashes)
      const before = await e.search("quokka")
      expect(before.hits).toHaveLength(2)
      const primary = before.hits[0]!.path
      const pending = e.search("quokka", "find", { groupDuplicates: true, budgetMs: 1000 })
      await opening
      if (change === "exclude-all") e.config = { ...config, exclude: [docs] }
      else if (change === "exclude-primary") e.config = { ...config, exclude: [primary] }
      else if (change === "names-only") e.config = { ...config, namesOnly: [docs] }
      else e.config = { ...config, content: { ...config.content, enabled: false } }
      resume()
      const result = await pending
      if (change === "exclude-all") {
        expect(result.hits).toHaveLength(0)
        expect(result.total).toBe(0)
      } else if (change === "exclude-primary") {
        expect(result.hits).toHaveLength(1)
        expect(result.hits[0]!.path).not.toBe(primary)
        expect(result.hits[0]!.copies).toBeUndefined()
        expect(result.total).toBe(1)
      } else {
        expect(result.hits).toHaveLength(1)
        expect(result.hits[0]!.copies).toHaveLength(1)
        expect(result.hits[0]!.sources).toEqual(["name"])
        expect(result.hits[0]!.lines).toEqual([])
        expect(result.hits[0]!.matchCount).toBe(0)
      }
    }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})

test("CopyHashes hashes the smallest first and resumes where it stopped", async () => {
  const bytes = { small: Buffer.alloc(100, 1), big: Buffer.alloc(900_000, 2), other: Buffer.alloc(50, 3) }
  type Name = keyof typeof bytes
  const meta: Record<Name, { dev: number; ino: number }> = { small: { dev: 1, ino: 11 }, big: { dev: 1, ino: 12 }, other: { dev: 1, ino: 13 } }
  const targetOf = (name: Name) => ({ path: `/fake/${name}`, ...meta[name], size: bytes[name].length, mtimeMs: 1000, ctimeMs: 1000 })
  const opened: string[] = [], reads: { name: string; position: number }[] = []
  const gates: (() => void)[] = []
  const openFile: FileOpener = async (path) => {
    const name = path.slice(6) as Name
    opened.push(name)
    return {
      stat: async () => ({ ...targetOf(name), isFile: () => true }),
      read: (buffer, position) => new Promise<number>((resolve) => {
        reads.push({ name, position })
        gates.push(() => { const chunk = bytes[name].subarray(position, position + buffer.length); buffer.set(chunk); resolve(chunk.length) })
      }),
      close: async () => {},
    }
  }
  const hashes = new CopyHashes({ open: openFile })
  const until = async (n: number) => { while (reads.length < n) await new Promise((r) => setImmediate(r)) }
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")
  const deadline = () => performance.now() + 5000

  const first = hashes.hash([targetOf("big"), targetOf("small")], deadline())
  await until(1)
  // The big file was asked for first, but the small one is read first.
  expect(opened).toEqual(["small"])
  gates.shift()!()
  await until(2)
  expect(opened).toEqual(["small", "big"])
  expect(hashes.get(targetOf("small"))).toBe(sha(bytes.small))
  // A new request makes the big file wait; what was read of it is kept.
  const second = hashes.hash([targetOf("other")], deadline())
  gates.shift()!()
  await until(3)
  gates.shift()!()
  await second
  await first
  expect(hashes.get(targetOf("big"))).toBeUndefined()
  const third = hashes.hash([targetOf("big")], deadline())
  await until(4); gates.shift()!()
  await until(5); gates.shift()!()
  await until(6); gates.shift()!()
  await third
  expect(hashes.get(targetOf("big"))).toBe(sha(bytes.big))
  // Resumed, not restarted: every chunk of the big file was read exactly once.
  expect(reads.filter((r) => r.name === "big").map((r) => r.position)).toEqual([0, 262144, 524288, 786432])
})
