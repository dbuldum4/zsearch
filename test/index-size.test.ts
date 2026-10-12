import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig, type Config } from "../src/config.ts"
import { byteTerms } from "../src/index/byte-terms.ts"
import { clearIndex, compactIndex, compressText, decompressText, getMeta, openDb, readContent, setMeta, TEXT_HASHES } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { ftsBody, indexTerms, isLongWord, shortWord } from "../src/util/text.ts"
import { FIXTURES } from "./helpers/corpus.ts"

const SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
const GIT = "3a7bd3e2360a3d29eea436fcfb7e44c735d117c4"
const MIDDLE = SHA.slice(20, 44)

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zsearch-size-"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function setup(name: string, files: Record<string, string>, more: Partial<Config> = {}) {
  const base = join(dir, name)
  const root = join(base, "docs")
  mkdirSync(root, { recursive: true })
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true })
    writeFileSync(join(root, p), text)
  }
  const config: Config = { ...defaultConfig(), roots: [root], indexLoad: 100, ...more }
  const db = openDb(join(base, "index.db"))
  return { root, config, db, dbPath: join(base, "index.db") }
}

const names = (hits: { path: string }[]) => hits.map((h) => h.path.slice(h.path.lastIndexOf("/") + 1)).sort()
const count = (db: Database, sql: string, ...args: (string | number)[]) => (db.query(sql).get(...args) as { n: number }).n

describe("long words", () => {
  test("hashes go into the full-text index short, and every other word as it is", () => {
    expect(isLongWord(SHA)).toBe(true)
    expect(isLongWord(GIT)).toBe(true)
    expect(isLongWord("internationalization")).toBe(false)
    expect(isLongWord("x".repeat(65))).toBe(false)
    const short = shortWord(SHA)
    expect(short).toHaveLength(20)
    expect(short.startsWith(SHA.slice(0, 12))).toBe(true)
    expect(shortWord(SHA)).toBe(short)
    expect(shortWord(SHA.slice(0, 63) + "9")).not.toBe(short)
    const { body, terms } = indexTerms(`commit ${GIT}\nsha256: ${SHA.toUpperCase()}`)
    expect(body.split(" ")).toEqual(["commit", shortWord(GIT), "sha256", shortWord(SHA)])
    // The vocabulary keeps them whole: searches find them by any part.
    expect([...terms]).toEqual(["commit", GIT, "sha256", SHA])
  })

  test("the byte-level reader indexes the same words as the text one", () => {
    for (const text of [`a ${SHA} b ${SHA} c`, `naïve ${GIT} café`, `${"y".repeat(70)} ${SHA}`]) {
      const r = byteTerms(new TextEncoder().encode(text), `run-${text.length}`)
      expect(r && new TextDecoder().decode(r.body)).toBe(ftsBody(text))
      expect(r!.report()).toEqual([...indexTerms(text).terms])
    }
  })

  test("searches still find a hash: whole, by its start, its end or its middle, in both modes", async () => {
    const { config, db } = setup("hashes", {
      "lock.txt": `integrity ${SHA} resolved`,
      "log.txt": `deployed ${GIT} to production`,
      "other.txt": "nothing to see here",
    })
    await new Indexer(db, config, { inProcess: true }).run()
    // The index holds the short form only.
    expect(count(db, `SELECT count(*) AS n FROM fts WHERE fts MATCH ?`, `body : "${SHA}"`)).toBe(0)
    expect(count(db, `SELECT count(*) AS n FROM fts WHERE fts MATCH ?`, `body : "${shortWord(SHA)}"`)).toBe(1)
    const e = new SearchEngine(db, config)
    for (const mode of ["find", "fuzzy"] as const) {
      expect(names((await e.search(SHA, mode)).hits)).toEqual(["lock.txt"])
      expect(names((await e.search(GIT, mode)).hits)).toEqual(["log.txt"])
    }
    // Upper case makes a search case-sensitive, but not a keyword one.
    expect(names((await e.search(SHA.toUpperCase(), "fuzzy")).hits)).toEqual(["lock.txt"])
    expect(names((await e.search(`integrity ${SHA.slice(0, 20)}`)).hits)).toEqual(["lock.txt"])
    expect(names((await e.search(SHA.slice(0, 16), "fuzzy")).hits)).toEqual(["lock.txt"])
    expect(names((await e.search(SHA.slice(-24))).hits)).toEqual(["lock.txt"])
    expect(names((await e.search(MIDDLE)).hits)).toEqual(["lock.txt"])
    expect(names((await e.search(`/${SHA.slice(4, 30)}/`)).hits)).toEqual(["lock.txt"])
    // A hash that is not there is still no match, at once.
    expect((await e.search(SHA.replace("9f86", "0000"))).hits).toEqual([])
    db.close()
  })
  test("a prefix shared by too many hashes to list still finds only files with words that start with it", async () => {
    const head = "c0ffee0123456789"
    // 80 hashes starting with the same 16 characters: too many to list, so the search falls
    // back to every word with their first 12, and checks the matches against the text.
    const hashes = Array.from({ length: 80 }, (_, i) => head + i.toString(16).padStart(4, "0") + "ab".repeat(10))
    const { config, db } = setup("prefix-overflow", {
      "hashes.txt": hashes.join("\n"),
      "decoy.txt": `a different word ${head.slice(0, 12)}ffffzz shares only the head`,
      "c0ffee0123456789-notes.txt": "named after the prefix",
    })
    await new Indexer(db, config, { inProcess: true }).run()
    const e = new SearchEngine(db, config)
    expect(e.vocab.longStartingWith(head)).toBeNull()
    expect(names((await e.search(head, "fuzzy")).hits)).toEqual(["c0ffee0123456789-notes.txt", "hashes.txt"])
    expect(names((await e.search(head)).hits)).toEqual(["c0ffee0123456789-notes.txt", "hashes.txt"])
    // With another word that no file has with it, any of them: still not the decoy.
    expect(names((await e.search(`zebraword ${head}`, "fuzzy")).hits)).toEqual(["c0ffee0123456789-notes.txt", "hashes.txt"])
    db.close()
  })
})

describe("stored texts", () => {
  test("a text held by several files is stored once, and goes with its last file", async () => {
    const report = "Quarterly report: revenue grew in every region.\n".repeat(50)
    const { root, config, db } = setup("dedupe", { "a/report.txt": report, "b/report copy.txt": report, "c/notes.txt": "other notes" })
    await new Indexer(db, config, { inProcess: true }).run()
    expect(count(db, "SELECT count(*) AS n FROM texts")).toBe(2)
    expect(count(db, "SELECT count(*) AS n FROM content")).toBe(3)
    const e = new SearchEngine(db, config)
    expect(names((await e.search("revenue grew")).hits)).toEqual(["report copy.txt", "report.txt"])
    for (const h of (await e.search("revenue")).hits) expect(readContent(db, h.id)).toBe(report)

    // One copy changes: it gets a text of its own, and the other keeps the shared one.
    writeFileSync(join(root, "a/report.txt"), report + "Revised.")
    await new Indexer(db, config, { inProcess: true }).run()
    expect(count(db, "SELECT count(*) AS n FROM texts")).toBe(3)
    // The other is deleted: its text goes, the changed copy's stays.
    rmSync(join(root, "b/report copy.txt"))
    await new Indexer(db, config, { inProcess: true }).run()
    expect(count(db, "SELECT count(*) AS n FROM texts")).toBe(2)
    // The indexer wrote on the engine's own connection, which SQLite does not report as a change.
    e.refresh(true)
    expect(names((await e.search("revised")).hits)).toEqual(["report.txt"])
    expect(count(db, "SELECT count(*) AS n FROM texts WHERE id NOT IN (SELECT text FROM content_map)")).toBe(0)
    db.close()
  })

  test("the content view takes writes and deletes as the table it replaced did", () => {
    const db = openDb(":memory:")
    db.query("INSERT INTO content(id, data) VALUES (?, ?)").run(7, compressText("seven"))
    db.query("INSERT INTO content(id, data) VALUES (?, ?)").run(7, compressText("seven again"))
    expect(readContent(db, 7)).toBe("seven again")
    expect(count(db, "SELECT count(*) AS n FROM texts")).toBe(1)
    db.query("DELETE FROM content WHERE id = ?").run(7)
    expect(count(db, "SELECT count(*) AS n FROM texts")).toBe(0)
    db.close()
  })

  test("texts compress about as well as they did at least", () => {
    for (const size of [500, 4000, 40_000]) {
      const text = Array.from({ length: size / 20 }, (_, i) => `line ${i} of words `).join("\n")
      const z = compressText(text)
      expect(decompressText(z)).toBe(text)
      if (size >= 1024) expect(z.length).toBeLessThan(text.length / 3)
    }
  })
})

/**
 * Turn a version 10 index back into the layout version 9 wrote: one `content` row per file,
 * no hashes, long words whole in the full-text index, no OCR cache.
 */
function downgradeTo9(db: Database) {
  db.transaction(() => {
    db.exec("CREATE TABLE content9 (id INTEGER PRIMARY KEY, data BLOB NOT NULL)")
    for (const r of db.query("SELECT m.id, t.data FROM content_map m JOIN texts t ON t.id = m.text").all() as { id: number; data: Uint8Array }[])
      db.query("INSERT INTO content9(id, data) VALUES (?, ?)").run(r.id, compressText(decompressText(r.data)))
    for (const t of ["content_insert", "content_delete", "content_map_delete", "content_map_update"]) db.exec(`DROP TRIGGER ${t}`)
    db.exec("DROP VIEW content")
    db.exec("DROP TABLE content_map")
    db.exec("DROP TABLE texts")
    db.exec("DROP TABLE ocr_cache")
    db.exec("ALTER TABLE content9 RENAME TO content")
    for (const r of db.query("SELECT f.id, f.name, c.data FROM files f JOIN content c ON c.id = f.id").all() as { id: number; name: string; data: Uint8Array }[]) {
      const whole = [...new Set(decompressText(r.data).toLowerCase().match(/[a-z0-9]+/g) ?? [])].join(" ")
      db.query("DELETE FROM fts WHERE rowid = ?").run(r.id)
      db.query("INSERT INTO fts(rowid, name, dirs, body) VALUES (?, ?, '', ?)").run(r.id, r.name.replace(/\W+/g, " "), whole)
    }
    setMeta(db, "schema_version", "9")
  })()
}

describe("upgrading a version 9 index", () => {
  test("happens in place: nothing is read again, copies are shared, and hashes are re-indexed short", async () => {
    const shared = `Shared text with ${SHA} inside.\n`.repeat(40)
    const { config, db, dbPath } = setup("upgrade", { "one.txt": shared, "two.txt": shared, "three.txt": `just ${GIT}` })
    await new Indexer(db, config, { inProcess: true }).run()
    downgradeTo9(db)
    db.close()

    const up = openDb(dbPath)
    expect(getMeta(up, "schema_version")).toBe("10")
    expect(getMeta(up, TEXT_HASHES)).toBe("1")
    expect(count(up, "SELECT count(*) AS n FROM texts")).toBe(3)
    // Readers work before the upgrade pass, through the view.
    expect(count(up, "SELECT count(*) AS n FROM content")).toBe(3)
    const e = new SearchEngine(up, config)
    expect(names((await e.search(SHA)).hits)).toEqual(["one.txt", "two.txt"])

    const progress = await new Indexer(up, config, { inProcess: true }).run()
    expect(progress.phase).toBe("done")
    expect(progress.contentTotal).toBe(0)
    expect(getMeta(up, TEXT_HASHES)).toBe("")
    expect(count(up, "SELECT count(*) AS n FROM texts")).toBe(2)
    expect(count(up, "SELECT count(*) AS n FROM content_map WHERE hash IS NULL")).toBe(0)
    expect(count(up, `SELECT count(*) AS n FROM fts WHERE fts MATCH ?`, `body : "${SHA}"`)).toBe(0)
    expect(count(up, `SELECT count(*) AS n FROM fts WHERE fts MATCH ?`, `body : "${shortWord(SHA)}"`)).toBe(2)
    e.refresh(true)
    for (const mode of ["find", "fuzzy"] as const) {
      expect(names((await e.search(SHA, mode)).hits)).toEqual(["one.txt", "two.txt"])
      expect(names((await e.search(GIT, mode)).hits)).toEqual(["three.txt"])
    }
    expect(names((await e.search(MIDDLE)).hits)).toEqual(["one.txt", "two.txt"])
    up.close()
  })

  test("an index on the classic FTS delete protocol is rebuilt instead", () => {
    const path = join(dir, "manual.db")
    const db = openDb(path, { manualFtsDelete: true })
    db.query("INSERT INTO files(path, name, ext, kind) VALUES ('/x/a.txt', 'a.txt', 'txt', 'text')").run()
    setMeta(db, "schema_version", "9")
    db.close()
    const again = openDb(path, { manualFtsDelete: true })
    expect(count(again, "SELECT count(*) AS n FROM files")).toBe(0)
    expect(getMeta(again, TEXT_HASHES)).toBeNull()
    again.close()
  })
})

describe("OCR results", () => {
  let tool: string
  let calls: string
  let before: string | undefined
  beforeAll(() => {
    tool = join(dir, "zsearch-ocr")
    calls = join(dir, "ocr-calls")
    writeFileSync(calls, "")
    writeFileSync(
      tool,
      `#!/bin/sh
echo "$2" >> "${calls}"
case "$(basename "$2")" in
  key.png) printf -- '-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----\\nkeyfile caption' ;;
  *) echo "Receipt total 42.00 from $(basename "$2")" ;;
esac
`,
    )
    chmodSync(tool, 0o755)
    before = process.env.ZSEARCH_OCR
    process.env.ZSEARCH_OCR = tool
  })
  afterAll(() => {
    if (before === undefined) delete process.env.ZSEARCH_OCR
    else process.env.ZSEARCH_OCR = before
  })
  const png = String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4)
  const ocrCalls = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).length

  test("are kept by file, so a rebuilt index does not read the images again", async () => {
    const { root, config, db, dbPath } = setup("ocr", { "scan.png": png, "photo.png": png + "x", "key.png": png + "k" })
    writeFileSync(calls, "")
    await new Indexer(db, config, { inProcess: true }).run()
    expect(ocrCalls()).toBe(3)
    // Text with a key in it is not kept.
    expect(count(db, "SELECT count(*) AS n FROM ocr_cache")).toBe(2)

    // A schema change rebuilds the index from scratch.
    setMeta(db, "schema_version", "8")
    db.close()
    const rebuilt = openDb(dbPath)
    expect(count(rebuilt, "SELECT count(*) AS n FROM files")).toBe(0)
    writeFileSync(calls, "")
    await new Indexer(rebuilt, config, { inProcess: true }).run()
    expect(readFileSync(calls, "utf8").trim().split("\n").map((p) => p.slice(p.lastIndexOf("/") + 1))).toEqual(["key.png"])
    const e = new SearchEngine(rebuilt, config)
    expect(names((await e.search("receipt")).hits)).toEqual(["photo.png", "scan.png"])

    // A changed image is read again; a deleted one's text is dropped.
    writeFileSync(join(root, "scan.png"), png + "changed")
    rmSync(join(root, "photo.png"))
    writeFileSync(calls, "")
    await new Indexer(rebuilt, config, { inProcess: true }).run()
    expect(ocrCalls()).toBe(1)
    expect(count(rebuilt, "SELECT count(*) AS n FROM ocr_cache")).toBe(1)

    // A rebuild asked for keeps it, and drops what it no longer indexes.
    clearIndex(rebuilt)
    expect(count(rebuilt, "SELECT count(*) AS n FROM ocr_cache")).toBe(1)
    rmSync(join(root, "scan.png"))
    writeFileSync(calls, "")
    await new Indexer(rebuilt, config, { inProcess: true }).run()
    expect(ocrCalls()).toBe(1)
    expect(count(rebuilt, "SELECT count(*) AS n FROM ocr_cache")).toBe(0)
    rebuilt.close()
  })

  test("are dropped when OCR is turned off", async () => {
    const { config, db } = setup("ocr-off", { "scan.png": png })
    await new Indexer(db, config, { inProcess: true }).run()
    expect(count(db, "SELECT count(*) AS n FROM ocr_cache")).toBe(1)
    await new Indexer(db, { ...config, content: { ...config.content, ocr: false } }, { inProcess: true }).run()
    expect(count(db, "SELECT count(*) AS n FROM ocr_cache")).toBe(0)
    db.close()
  })

  test("are dropped when OCR is turned off, also for a PDF that keeps text of its own", async () => {
    const { root, config, db } = setup("ocr-off-pdf", {})
    copyFileSync(join(FIXTURES, "pages/blank-pages.pdf"), join(root, "scanned.pdf"))
    writeFileSync(calls, "")
    await new Indexer(db, config, { inProcess: true }).run()
    expect(ocrCalls()).toBe(1)
    expect(count(db, "SELECT count(*) AS n FROM ocr_cache")).toBe(1)
    const off = { ...config, content: { ...config.content, ocr: false } }
    await new Indexer(db, off, { inProcess: true }).run()
    expect(count(db, "SELECT count(*) AS n FROM files WHERE content_state = 1")).toBe(1)
    expect(count(db, "SELECT count(*) AS n FROM ocr_cache")).toBe(0)
    const e = new SearchEngine(db, off)
    expect(names((await e.search("calvin")).hits)).toEqual(["scanned.pdf"])
    expect((await e.search("receipt")).hits).toEqual([])
    db.close()
  })
})

describe("compaction", () => {
  test("the log is kept small, and space freed by a big change goes back to the file system", async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 300; i++) files[`f${i}.txt`] = `file ${i} ` + Array.from({ length: 2000 }, (_, k) => `w${(i * 7919 + k * 104729) % 1_000_003}`).join(" ")
    const { root, config, db, dbPath } = setup("compact", files)
    expect((db.query("PRAGMA journal_size_limit").get() as { journal_size_limit: number }).journal_size_limit).toBe(64 * 1024 * 1024)
    await new Indexer(db, config, { inProcess: true }).run()
    const pages = () => (db.query("PRAGMA page_count").get() as { page_count: number }).page_count
    const full = pages()
    // A reader stays open meanwhile, as the app's search engine does.
    const reader = new Database(dbPath, { readonly: true })
    expect(count(reader, "SELECT count(*) AS n FROM files")).toBeGreaterThanOrEqual(300)
    for (let i = 0; i < 280; i++) rmSync(join(root, `f${i}.txt`))
    await new Indexer(db, config, { inProcess: true }).run()
    expect(pages()).toBeLessThan(full / 2)
    expect((db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count).toBeLessThan(pages() / 10)
    expect(count(reader, "SELECT count(*) AS n FROM files WHERE is_dir = 0")).toBe(20)
    reader.close()
    // Nothing to give back: nothing is done.
    expect(compactIndex(db, false)).toBe(false)
    db.close()
  })
})
