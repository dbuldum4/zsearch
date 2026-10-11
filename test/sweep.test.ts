import { describe, expect, test } from "bun:test"
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

  test("database and its journals are private even with a public umask", async () => fixture(async (dir, _c, e) => {
    for (const suffix of ["", "-wal", "-shm"]) expect(statSync(join(dir, "..", "index.db") + suffix).mode & 0o777).toBe(0o600)
    expect(e.db.filename).toBeTruthy()
  }))

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
