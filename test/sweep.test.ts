import { describe, expect, spyOn, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { defaultConfig, setConfigValue, withConfigSetting } from "../src/config.ts"
import { openDb, indexStats, ContentState, getMeta } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { readIndexed } from "../src/search/read.ts"
import { foldTerm } from "../src/util/text.ts"
import { xmlText, htmlText, tidy } from "../src/index/extract/xml.ts"
import { pathPolicy, crawlOptionsFor } from "../src/index/policy.ts"
import { DEFAULT_EXTRACT } from "../src/index/extract/index.ts"
import { ExtractPool } from "../src/index/pool.ts"
import { withSetting } from "../src/mcp/server.ts"
import { SearchClient } from "../src/search/client.ts"
import { editorCommand } from "../src/platform.ts"
import type { SearchOut } from "../src/search/protocol.ts"
import { testClock } from "./helpers/clock.ts"
import { waitFor } from "./helpers/wait.ts"

async function fixture(run: (dir: string, c: ReturnType<typeof defaultConfig>, e: SearchEngine) => Promise<void>, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zsearch-sweep-"))
  const root = join(dir, "docs")
  mkdirSync(root)
  const c = { ...defaultConfig(), roots: [root], indexLoad: 100 }
  const db = openDb(join(dir, "index.db"))
  try {
    for (const [name, text] of Object.entries(files)) { mkdirSync(join(root, name, ".."), { recursive: true }); writeFileSync(join(root, name), text) }
    await new Indexer(db, c, { inProcess: true }).run()
    await run(root, c, new SearchEngine(db, c))
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
}
const readOpts = { lines: 100, maxChars: 10000 }

describe("sweep regressions", () => {
  test("explicit root aliases override canonical system exclusions but retain user exclusions", async () => fixture(async (dir, c, e) => {
    // Like macOS /var -> /private/var: the selected alias is outside the automatic
    // exclusion, but its actual target is beneath one (/tmp on Linux).
    const scratch = mkdtempSync(join(import.meta.dir, ".root-alias-"))
    const alias = join(scratch, "selected")
    try {
      symlinkSync(dir, alias)
      c.roots = [alias]
      const file = join(alias, "a.txt")
      expect(pathPolicy(file, crawlOptionsFor(c)).content).toBe(true)
      await new Indexer(e.db, c, { inProcess: true }).run()
      e.refresh(true)
      expect((await e.search("CANONICALROOTZEBRA")).hits.map((h) => h.path)).toEqual([file])
      c.exclude = [dir]
      expect(pathPolicy(file, crawlOptionsFor(c)).allowed).toBe(false)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  }, { "a.txt": "CANONICALROOTZEBRA" }))

  test("permission failures preserve a subtree while real deletions are removed", async () => fixture(async (dir, c, e) => {
    const sub = join(dir, "sub")
    chmodSync(sub, 0)
    rmSync(join(dir, "gone.txt"))
    try {
      const progress = await new Indexer(e.db, c, { inProcess: true }).run()
      expect(progress.unreadableFolders).toBe(1)
      expect(progress.removed).toBe(1)
      expect(indexStats(e.db).files).toBe(1)
      expect(indexStats(e.db).unreadableFolders).toEqual([sub])
    } finally { chmodSync(sub, 0o700) }
  }, { "sub/kept.txt": "keep me", "gone.txt": "delete me" }))

  test("new content settings with a folder unreadable apply once, not again on every run", async () => fixture(async (dir, c, e) => {
    const sub = join(dir, "sub")
    const found = (word: string) => (e.db.query("SELECT count(*) AS n FROM fts WHERE fts MATCH ?").get(word) as { n: number }).n
    expect(found("zeppelin")).toBe(1)
    chmodSync(sub, 0)
    try {
      c.content = { ...c.content, maxChars: c.content.maxChars - 1 }
      expect((await new Indexer(e.db, c, { inProcess: true }).run()).contentTotal).toBe(1)
      // Read under the old settings and out of reach now: dropped, not kept as if current.
      expect(found("zeppelin")).toBe(0)
      expect((await new Indexer(e.db, c, { inProcess: true }).run()).contentTotal).toBe(0)
    } finally { chmodSync(sub, 0o700) }
    expect((await new Indexer(e.db, c, { inProcess: true }).run()).contentTotal).toBe(1)
    expect(found("zeppelin")).toBe(1)
  }, { "sub/plan.txt": "zeppelin route", "top.txt": "airship" }))

  test("symlinks obey containment and target content/exclusion policy", async () => fixture(async (dir, c, e) => {
    const outside = join(dir, "..", "secret.txt")
    writeFileSync(outside, "OUTSIDEZEBRA")
    symlinkSync(outside, join(dir, "outside.txt"))
    symlinkSync(join(dir, "private", "diary.txt"), join(dir, "alias.txt"))
    c.followSymlinks = true; c.namesOnly = [join(dir, "private")]
    expect(pathPolicy(join(dir, "outside.txt"), crawlOptionsFor(c)).allowed).toBe(false)
    expect(pathPolicy(join(dir, "alias.txt"), crawlOptionsFor(c)).content).toBe(false)
    c.exclude = ["private/"]
    expect(pathPolicy(join(dir, "alias.txt"), crawlOptionsFor(c)).allowed).toBe(false)
    await new Indexer(e.db, c, { inProcess: true }).run()
    expect((await e.search("OUTSIDEZEBRA")).hits).toEqual([])
  }, { "private/diary.txt": "private secret" }))

  test("stored text, previews and disk fallback honor policy changes before reindex", async () => fixture(async (dir, c, e) => {
    const path = join(dir, "a.txt")
    const id = (e.db.query("SELECT id FROM files WHERE path = ?").get(path) as { id: number }).id
    expect(readIndexed(e, path, "", "find", readOpts)?.source).toBe("index")
    c.namesOnly = [dir]
    expect(readIndexed(e, path, "", "find", readOpts)?.source).toBe("none")
    expect(e.preview(id, "", "find").source).toBe("none")
    expect((await e.search("PRIVATEZEBRA")).hits).toEqual([])
    expect((await e.search("PRIVATEZEBRA")).total).toBe(0)
    expect((await e.search("PRIVATEZEBRA")).strategy).toContain("0 of 0")
    expect((await e.search("PRIVATEZEBRZ")).notice ?? "").not.toContain("privatezebra")
    e.db.exec("DELETE FROM content")
    e.db.query("UPDATE files SET content_state = ?").run(ContentState.None)
    expect(readIndexed(e, path, "", "find", readOpts)?.source).toBe("none")
    c.namesOnly = []; c.content.enabled = false
    expect(readIndexed(e, path, "", "find", readOpts)?.source).toBe("none")
    c.content.enabled = true; c.exclude = ["*.txt"]
    expect(readIndexed(e, path, "", "find", readOpts)).toBeNull()
  }, { "a.txt": "PRIVATEZEBRA" }))

  test("all supplied languages are searchable and Latin accents still fold", async () => fixture(async (_dir, _c, e) => {
    for (const word of ["йогурт", "ёлка", "データベース", "한국어", "शांति", "كِتَابٌ", "ภาษาไทย"]) {
      expect(foldTerm(word)).toBe(word)
      expect((await e.search(word)).hits.length).toBe(1)
    }
    expect(foldTerm("café")).toBe("cafe")
    expect((await e.search("cafe", "fuzzy")).hits.length).toBe(1)
  }, { "languages.txt": "йогурт ёлка データベース 한국어 शांति كِتَابٌ ภาษาไทย café" }))

  test("ranking, negated filters, quoted literals and regex flags", async () => fixture(async (_dir, _c, e) => {
    const ranked = await e.search("budget", "find", { limit: 1 })
    expect(ranked.hits[0]?.path.endsWith("best.txt")).toBe(true)
    expect((await e.search('"budget report" 2024')).hits.length).toBe(1)
    expect((await e.search("/BUDGET/i")).hits.length).toBe(3)
    expect((await e.search("budget -ext:txt")).hits.every((h) => h.path.endsWith(".md"))).toBe(true)
    expect((await e.search("budget -path:sub")).hits.some((h) => h.path.includes("/sub/"))).toBe(false)
    expect((await e.search("budget -size:>1b")).hits).toEqual([])
  }, { "best.txt": "budget budget budget budget", "sub/other.md": "budget", "phrase.txt": "budget report 2024" }))

  test("personal ignore files work when gitignore is disabled", async () => fixture(async (dir, c, e) => {
    writeFileSync(join(dir, ".zsearchignore"), "private.txt\n")
    c.respectGitignore = false
    await new Indexer(e.db, c, { inProcess: true }).run()
    expect((await e.search("PRIVATEZEBRA")).hits).toEqual([])
  }, { "private.txt": "PRIVATEZEBRA" }))

  test("search stages never retain ignore rules between requests", async () => fixture(async (dir, _c, e) => {
    for (const mode of ["find", "fuzzy"] as const) expect((await e.search("PRIVATEZEBRA", mode)).hits).toHaveLength(2)
    const ignoreFile = join(dir, ".zsearchignore")
    writeFileSync(ignoreFile, "*.txt\n")
    for (const mode of ["find", "fuzzy"] as const) {
      const result = await e.search("PRIVATEZEBRA", mode)
      expect(result.hits).toEqual([])
      expect(result.total).toBe(0)
    }
    const before = statSync(ignoreFile)
    writeFileSync(ignoreFile, "*.log\n") // Same inode, size and restored mtime.
    const { utimesSync } = await import("node:fs")
    utimesSync(ignoreFile, before.atime, before.mtime)
    for (const mode of ["find", "fuzzy"] as const) expect((await e.search("PRIVATEZEBRA", mode)).hits).toHaveLength(2)
    rmSync(ignoreFile)
    for (const mode of ["find", "fuzzy"] as const) expect((await e.search("PRIVATEZEBRA", mode)).hits).toHaveLength(2)
  }, { "a.txt": "PRIVATEZEBRA", "b.txt": "PRIVATEZEBRA" }))

  test("content commits advance sequence and unrelated cached text survives", async () => fixture(async (dir, c, e) => {
    const before = Number(getMeta(e.db, "change_seq"))
    const ids = e.db.query("SELECT id FROM files ORDER BY path").values() as number[][]
    e.preview(ids[0]![0]!, "", "find")
    const cache = (e as any).texts.map as Map<number, string>
    writeFileSync(join(dir, "b.txt"), "changed text with a different size")
    await new Indexer(e.db, c, { inProcess: true }).run()
    e.refresh(true)
    expect(Number(getMeta(e.db, "change_seq"))).toBeGreaterThan(before)
    expect(cache.has(ids[0]![0]!)).toBe(true)
  }, { "a.txt": "keep in cache", "b.txt": "old" }))

  test("malformed XML and HTML cannot trigger the quadratic tokenizer", () => {
    const attack = "<a ".repeat(40000)
    const started = performance.now()
    expect(xmlText(attack, {})).toBe("")
    expect(htmlText(attack)).toBe("")
    expect(tidy("A" + " ".repeat(40000) + "B")).toHaveLength(40002)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("MCP cannot set executable or privacy controls, local settings share validation", () => {
    const c = defaultConfig()
    for (const key of ["editor", "roots", "includeHidden", "exclude", "content.enabled"]) expect(() => withSetting(c, key, "bash -c touch${IFS}/tmp/pwned")).toThrow()
    expect(() => editorCommand("bash -c echo", "/tmp/test")).toThrow("command interpreter")
    const marker = join(tmpdir(), "zsearch-editor-injection-marker")
    rmSync(marker, { force: true })
    expect(() => editorCommand(`vi;touch\${IFS}${marker}`, "/tmp/test")).toThrow()
    expect(existsSync(marker)).toBe(false)
    expect(editorCommand("vi", "/tmp/test", 12).slice(-2)).toEqual(["+12", "/tmp/test"])
    expect(() => setConfigValue(c, "indexLoad", "5")).toThrow()
    expect(() => setConfigValue(c, "defaultMode", "anything")).toThrow()
    expect(withConfigSetting(c, "indexLoad", "10").indexLoad).toBe(10)
  })

  test("database and its journals are private even with a public umask", () => {
    const dir = mkdtempSync(join(tmpdir(), "zsearch-umask-"))
    const previous = process.umask(0)
    let db: ReturnType<typeof openDb> | undefined
    try {
      const path = join(dir, "index.db")
      db = openDb(path)
      db.exec("INSERT INTO meta VALUES ('umask-test', 'written')")
      for (const suffix of ["", "-wal", "-shm"]) expect(statSync(path + suffix).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(previous)
      try { db?.close() } finally { rmSync(dir, { recursive: true, force: true }) }
    }
  })

  test("the extraction deadline replaces a worker and later jobs still work", async () => fixture(async (dir) => {
    const tool = join(dir, "ocr")
    writeFileSync(tool, "#!/bin/sh\nsleep 1\necho extracted\n", { mode: 0o700 })
    const pool = new ExtractPool(1, { ...DEFAULT_EXTRACT, ocrTool: tool, fileTimeoutMs: 25 })
    try {
      const r = await pool.run({ id: 1, run: "deadline", path: join(dir, "slow.png"), ext: "png", kind: "image", size: 1 })
      expect(r.status).toBe("error")
      if (r.status === "error") expect(r.error).toBe("timed out")
      const next = await pool.run({ id: 2, run: "deadline", path: join(dir, "ok.txt"), ext: "txt", kind: "text", size: 2 })
      expect(next.status).toBe("ok")
    } finally { pool.close() }
  }, { "slow.png": "x", "ok.txt": "ok" }))
})


test("nested roots cannot bypass ancestor ignores", async () => fixture(async (dir, c, e) => {
  c.roots.push(join(dir, "private"))
  writeFileSync(join(dir, ".gitignore"), "private/\n")
  expect(readIndexed(e, join(dir, "private", "secret.txt"), "", "find", readOpts)).toBeNull()
  expect((await e.search("PRIVATEZEBRA")).total).toBe(0)
}, { "private/secret.txt": "PRIVATEZEBRA" }))

test("broad searches rank an oversampled pool and explicit sorting considers later files", async () => {
  const files = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`note-${i}.txt`, "budget"]))
  files["note-80.txt"] = "budget ".repeat(20)
  files["note-200.txt"] = "budget " + "padding ".repeat(100)
  await fixture(async (dir, _c, e) => {
    const { utimesSync } = await import("node:fs")
    for (let i = 0; i < 250; i++) utimesSync(join(dir, `note-${i}.txt`), 1000 - i, 1000 - i)
    await new Indexer(e.db, _c, { inProcess: true }).run()
    e.refresh(true)
    const result = await e.search("budget", "find", { limit: 1 })
    expect(result.hits[0]?.path).toBe(join(dir, "note-80.txt"))
    expect(result.partial).toBe(true)
    expect((await e.search("budget sort:-size", "find", { limit: 1 })).hits[0]?.path).toBe(join(dir, "note-200.txt"))
  }, files)
})

test("repointed parent-directory aliases are checked again on the next request", async () => fixture(async (dir, c, e) => {
  const alias = join(dir, "linked")
  c.followSymlinks = true
  symlinkSync(join(dir, "public"), alias)
  await new Indexer(e.db, c, { inProcess: true }).run()
  expect(readIndexed(e, join(alias, "a.txt"), "", "find", readOpts)?.source).toBe("index")
  const outside = join(dir, "..", "outside")
  mkdirSync(outside); writeFileSync(join(outside, "a.txt"), "OUTSIDEZEBRA")
  rmSync(alias); symlinkSync(outside, alias)
  c.namesOnly = [join(dir, "public")]
  expect(readIndexed(e, join(alias, "a.txt"), "", "find", readOpts)).toBeNull()
  expect((await e.search("PRIVATEZEBRA")).hits).toEqual([])
  expect((await e.search("OUTSIDEZEBRA")).hits).toEqual([])
}, { "public/a.txt": "PRIVATEZEBRA" }))

test("repointed aliases cannot expose their old target and identical stat sizes reindex", async () => fixture(async (dir, c, e) => {
  c.followSymlinks = true
  const alias = join(dir, "alias.txt"), secret = join(dir, "private", "secret.txt"), publicFile = join(dir, "public.txt")
  const fs = await import("node:fs")
  fs.utimesSync(secret, 100, 100); fs.utimesSync(publicFile, 100, 100)
  symlinkSync(secret, alias)
  await new Indexer(e.db, c, { inProcess: true }).run()
  expect(readIndexed(e, alias, "", "find", readOpts)?.lines[0]?.text).toBe("PRIVATEZEBRA")
  c.namesOnly = [join(dir, "private")]
  rmSync(alias); symlinkSync(publicFile, alias)
  expect(readIndexed(e, alias, "", "find", readOpts)?.source).toBe("none")
  expect((await e.search("PRIVATEZEBRA")).total).toBe(0)
  await new Indexer(e.db, c, { inProcess: true }).run()
  expect(readIndexed(e, alias, "", "find", readOpts)?.lines[0]?.text).toBe("PUBLICZEBRA!")
}, { "private/secret.txt": "PRIVATEZEBRA", "public.txt": "PUBLICZEBRA!" }))

test("read_file regexes share the worker watchdog and requests recover afterward", async () => fixture(async (dir, c, e) => {
  const client = new SearchClient(e.db.filename, c, 50)
  let restarted = false
  client.onRestart = () => { restarted = true }
  try {
    await client.waitReady()
    const result = await client.read(join(dir, "a.txt"), "re:(a+)+$", "find", readOpts)
    expect(result).toBeNull()
    expect(restarted).toBe(true)
    await client.waitReady()
    expect((await client.stats())?.stats.files).toBe(1)
  } finally { client.close() }
}, { "a.txt": "a".repeat(35) + "!" }))

test("an index that can't be opened is reported at once, not after a timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zsearch-noindex-"))
  const blocker = join(dir, "not-a-folder")
  writeFileSync(blocker, "")
  const client = new SearchClient(join(blocker, "index.db"), defaultConfig())
  try {
    await client.waitReady()
    const started = Date.now()
    expect((await client.search("anything", "find"))?.error).toContain("could not open the index")
    expect(Date.now() - started).toBeLessThan(1000)
  } finally { client.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("new searches cannot postpone the watchdog for a superseded stuck search", async () => fixture(async (_dir, c, e) => {
  const client = new SearchClient(e.db.filename, c, 150)
  let changes: ReturnType<typeof setInterval> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  const restarted = new Promise<string>((resolve) => { client.onRestart = resolve })
  try {
    await client.waitReady()
    const stuck = client.search("re:(a+)+$", "find")
    // Give the worker the first query before continually replacing its caller.
    await Bun.sleep(30)
    changes = setInterval(() => { void client.search("ordinary", "find") }, 20)
    const reason = await Promise.race([
      restarted,
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("typing postponed recovery")), 2000) }),
    ])
    clearInterval(changes)
    expect(reason).toContain("was stopped")
    await stuck
    await client.waitReady()
    expect((await client.stats())?.stats.files).toBe(1)
  } finally { clearInterval(changes); clearTimeout(deadline); client.close() }
}, { "a.txt": "a".repeat(35) + "!" }))

test("healthy superseded searches and previews leave no watchdog deadlines behind", async () => fixture(async (_dir, c, e) => {
  const clock = testClock()
  const client = new SearchClient(e.db.filename, c, 250)
  const protocol = client as unknown as { handle(message: SearchOut): void }
  const deliver = protocol.handle.bind(client)
  const held: SearchOut[] = []
  let holdReplies = true
  // Hold real replies until a second batch has superseded the first batch's callers.
  const handle = spyOn(protocol, "handle").mockImplementation((message) => {
    if (holdReplies && "qid" in message) held.push(message)
    else deliver(message)
  })
  let restarts = 0
  client.onRestart = () => { restarts++ }
  try {
    await client.waitReady()
    const { id } = e.db.query("SELECT id FROM files WHERE name = 'a.txt'").get() as { id: number }
    const batch = () => [client.search("alpha", "find"), client.preview(id, "alpha", "find"), client.previews([id], "alpha", "find")]
    const superseded = batch()
    await waitFor(() => held.filter((m) => m.type === "completed").length === 3, "the first worker batch to finish")
    const current = batch()
    holdReplies = false
    for (const message of held) deliver(message)
    expect(await Promise.all(superseded)).toEqual([null, null, null])
    expect((await Promise.all(current)).every((reply) => reply !== null)).toBe(true)
    await waitFor(() => handle.mock.calls.filter(([m]) => m.type === "completed").length === 6, "all worker completion messages")
    clock.advance(1000)
    expect(restarts).toBe(0)
    expect((await client.stats())?.stats.files).toBe(1)
  } finally {
    client.close()
    handle.mockRestore()
    clock.restore()
  }
}, { "a.txt": "alpha beta" }))
