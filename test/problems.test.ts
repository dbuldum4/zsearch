import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { join } from "node:path"
import type { Config } from "../src/config.ts"
import { ContentState, hasReadAt, openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { eachProblem, explainPath, friendlyError, listProblems, problemCounts, retryProblems } from "../src/index/problems.ts"
import { homeConfig, makeCorpus } from "./helpers/corpus.ts"

let corpus: ReturnType<typeof makeCorpus>
let db: Database
const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME, ZSEARCH_OCR: process.env.ZSEARCH_OCR, ZSEARCH_TRANSCRIBE: process.env.ZSEARCH_TRANSCRIBE }

beforeAll(() => {
  corpus = makeCorpus()
  process.env.HOME = corpus.home
  process.env.ZSEARCH_HOME = join(corpus.home, ".zsearch-data")
  // The same answers on every machine: no OCR or speech helpers.
  process.env.ZSEARCH_OCR = "0"
  process.env.ZSEARCH_TRANSCRIBE = "0"
  corpus.write("Documents/broken.docx", "not really a docx")
  corpus.write("Documents/keys/server.pem", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n")
  corpus.write("Archive/old-report.txt", "quarterly report kept in a names-only folder\n")
  corpus.write("Documents/huge.txt", "x".repeat(4096))
  corpus.write("Downloads/blob", new Uint8Array(1024))
  db = openDb(":memory:")
})

afterAll(() => {
  db.close()
  corpus.cleanup()
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function config(): Config {
  const c = homeConfig()
  c.namesOnly = ["~/Archive"]
  c.content.maxTextMB = 2048 / (1024 * 1024)
  return c
}

const at = (rel: string) => join(corpus.home, rel)

function setRow(rel: string, state: number, note: string | null) {
  db.query("UPDATE files SET content_state = ?, note = ? WHERE path = ?").run(state, note, at(rel))
}

describe("indexing problems", () => {
  test("files are sorted into categories with plain-language reasons", async () => {
    expect((await new Indexer(db, config(), { inProcess: true }).run()).phase).toBe("done")
    // States the corpus cannot produce here (no OCR, transcription or long files).
    setRow("notes/journal-2024.md", ContentState.Indexed, "truncated")
    setRow("Documents/paper.pdf", ContentState.Error, "PDF parsing timed out after 60s")
    setRow("Music/song.mp3", ContentState.Error, "Apple speech is not ready: asset preparation timed out")
    setRow("Pictures/holiday-beach.jpg", ContentState.Skipped, "dataset")
    setRow("Documents/report.docx", ContentState.Skipped, "empty")

    const list = listProblems(db, config(), { limit: 1000 })
    const by = new Map(list.problems.map((p) => [p.path, p]))
    const broken = by.get(at("Documents/broken.docx"))!
    expect(broken.category).toBe("unreadable")
    expect(broken.reason).toBe("It is not in the format its name suggests, or it is damaged.")
    expect(broken.detail).toContain("not a valid Office file")
    expect(broken.retry).toBe(true)
    expect(broken.at).toBeGreaterThan(Date.now() - 600_000)
    expect(by.get(at("Documents/keys/server.pem"))).toMatchObject({ category: "secret", retry: false, detail: null })
    expect(by.get(at("Archive/old-report.txt"))).toMatchObject({ category: "names-only", retry: false, setting: "namesOnly" })
    expect(by.get(at("Documents/huge.txt"))).toMatchObject({ category: "too-large", retry: false, setting: "content.maxTextMB" })
    expect(by.get(at("notes/journal-2024.md"))).toMatchObject({ category: "truncated", setting: "content.maxChars" })
    expect(by.get(at("Documents/paper.pdf"))).toMatchObject({ category: "timeout", retry: true })
    expect(by.get(at("Music/song.mp3"))!.category).toBe("transcription")
    expect(by.get(at("Music/song.mp3"))!.reason).toContain("speech recognition was not ready")
    expect(by.get(at("Pictures/holiday-beach.jpg"))).toMatchObject({ category: "dataset", setting: "skipDatasetOcr" })
    expect(by.get(at("Documents/report.docx"))).toMatchObject({ category: "no-text", retry: true })
    // Binary files are not problems anyone can act on.
    expect(by.has(at("Downloads/blob"))).toBe(false)

    // Listed by category, then path; counts agree with the list.
    const order = list.problems.map((p) => p.category)
    expect(order).toEqual([...order].sort((a, b) => list.categories.findIndex((c) => c.category === a) - list.categories.findIndex((c) => c.category === b)))
    expect(list.total).toBe(list.problems.length)
    expect(list.categories.find((c) => c.category === "unreadable")).toEqual({ category: "unreadable", label: "Could not be read", count: 1, retry: true })
    expect(problemCounts(db, config())).toEqual(list.categories)
  })

  test("pages, category filters and path search", () => {
    const all = listProblems(db, config(), { limit: 1000 }).problems
    const page = listProblems(db, config(), { offset: 2, limit: 3 })
    expect(page.problems.map((p) => p.path)).toEqual(all.slice(2, 5).map((p) => p.path))
    const secrets = listProblems(db, config(), { categories: ["secret"] })
    expect(secrets.problems.map((p) => p.path)).toEqual([at("Documents/keys/server.pem")])
    expect(secrets.total).toBe(1)
    const found = listProblems(db, config(), { query: "BROKEN" })
    expect(found.problems.map((p) => p.path)).toEqual([at("Documents/broken.docx")])
    expect(found.categories.map((c) => c.category)).toEqual(["unreadable"])
    expect([...eachProblem(db, config(), { categories: ["timeout", "transcription"] })].map((p) => p.category)).toEqual(["timeout", "transcription"])
  })

  test("raw reader errors in plain words", () => {
    expect(friendlyError("permission denied")).toContain("Full Disk Access")
    expect(friendlyError("file disappeared")).toBe("It was moved or deleted while it was being read.")
    expect(friendlyError("document is password-protected")).toBe("It is password-protected or encrypted.")
    expect(friendlyError("MOBI book is encrypted")).toBe("It is password-protected or encrypted.")
    expect(friendlyError("zip inflate budget exceeded: word/document.xml")).toBe("It is too big or too complex inside to read safely.")
    expect(friendlyError("unsupported MOBI format (KF8)")).toBe("It uses a variant of its format that zsearch cannot read.")
    expect(friendlyError("corrupt piece table")).toBe("It looks damaged.")
    expect(friendlyError("extraction worker crashed")).toContain("stopped unexpectedly")
    expect(friendlyError("something nobody expected")).toBe("It could not be read.")
    expect(friendlyError(null)).toBe("It could not be read.")
  })

  test("why a single file is or is not searchable", () => {
    const c = config()
    expect(explainPath(db, c, "~/notes/recipes/pancakes.txt")).toMatchObject({ searchable: "content", category: null, retry: false })
    expect(explainPath(db, c, at("Documents/broken.docx"))).toMatchObject({ searchable: "name", category: "unreadable", retry: true })
    expect(explainPath(db, c, at("Archive/old-report.txt"))).toMatchObject({ searchable: "name", category: "names-only" })
    expect(explainPath(db, c, at("notes/journal-2024.md"))).toMatchObject({ searchable: "content", category: "truncated" })
    expect(explainPath(db, c, at("Downloads/blob")).reason).toContain("binary data")
    expect(explainPath(db, c, at("Downloads/archive.bin")).reason).toContain("does not read the contents of this kind of file")
    expect(explainPath(db, c, at("Notes"))).toMatchObject({ searchable: "none" })
    expect(explainPath(db, c, "/definitely/not/indexed.pdf")).toMatchObject({ searchable: "none", setting: "roots" })
    expect(explainPath(db, c, at("code/app/debug.log"))).toMatchObject({ searchable: "none", setting: "exclude" })
    expect(explainPath(db, c, at("Documents"))).toMatchObject({ searchable: "name", reason: "Folders are found by name." })
    const off = config()
    off.content.enabled = false
    setRow("notes/todo.md", ContentState.None, null)
    expect(explainPath(db, off, at("notes/todo.md"))).toMatchObject({ searchable: "name", setting: "content.enabled" })
    expect(explainPath(db, c, at("notes/todo.md")).reason).toContain("next index update")
  })

  test("retrying marks files for the next update; privacy and settings problems are refused", async () => {
    expect(() => retryProblems(db, config(), { category: "secret" })).toThrow("never read")
    expect(() => retryProblems(db, config(), { category: "too-large" })).toThrow("content.maxDocumentMB or content.maxTextMB")
    const one = retryProblems(db, config(), { paths: [at("Documents/broken.docx"), at("Documents/keys/server.pem"), "~/notes/recipes/pancakes.txt"] })
    expect(one.retried).toBe(1)
    expect(one.refused.map((r) => r.path)).toEqual([at("Documents/keys/server.pem"), at("notes/recipes/pancakes.txt")])
    expect(one.refused[0]!.reason).toContain("never read")
    expect(one.refused[1]!.reason).toStartWith("Nothing to read again.")
    const row = () => db.query("SELECT content_state AS state, note FROM files WHERE path = ?").get(at("Documents/broken.docx")) as { state: number; note: string | null }
    expect(row()).toEqual({ state: ContentState.Pending, note: null })
    // The next update reads it again: errors otherwise wait until the file changes.
    const run = await new Indexer(db, config(), { inProcess: true }).run()
    expect(run.contentErrors).toBe(1)
    expect(row().state).toBe(ContentState.Error)
    expect(retryProblems(db, config(), { category: "unreadable" }).retried).toBe(1)
    expect(row().state).toBe(ContentState.Pending)
    expect(retryProblems(db, config(), { category: "timeout" }).retried).toBe(1)
  })

  test("older indexes get the column that says when contents were read", () => {
    const path = join(corpus.home, "old-index.db")
    const old = openDb(path)
    old.exec("ALTER TABLE files DROP COLUMN read_at")
    expect(hasReadAt(old)).toBe(false)
    // Read-only readers of an index not migrated yet still list its problems.
    old.query("INSERT INTO files(path, name, ext, kind, content_state, note) VALUES (?, 'x.docx', 'docx', 'doc', 2, 'corrupt piece table')").run(at("x.docx"))
    expect(listProblems(old, config()).problems[0]).toMatchObject({ category: "unreadable", at: null })
    old.close()
    const reopened = openDb(path)
    expect(hasReadAt(reopened)).toBe(true)
    reopened.close()
  })

  test("path search keeps non-ASCII letters as they are", () => {
    const own = openDb(":memory:")
    try {
      own.query("INSERT INTO files(path, name, ext, kind, content_state, note) VALUES (?, 'Übersicht.docx', 'docx', 'doc', 2, 'corrupt piece table')").run(at("Documents/Übersicht.docx"))
      expect(listProblems(own, config(), { query: "Übersicht" }).problems.map((p) => p.path)).toEqual([at("Documents/Übersicht.docx")])
      expect(listProblems(own, config(), { query: "DOCUMENTS/Ü" }).total).toBe(1)
    } finally {
      own.close()
    }
  })

  test("leaving a listing early does not pin the connection to an old snapshot", () => {
    const path = join(corpus.home, "snapshot.db")
    const reader = openDb(path)
    const writer = openDb(path)
    try {
      const add = (name: string) => writer.query("INSERT INTO files(path, name, ext, kind, content_state, note) VALUES (?, ?, 'docx', 'doc', 2, 'corrupt piece table')").run(at(name), name)
      add("a.docx")
      add("b.docx")
      for (const _ of eachProblem(reader, config())) break
      add("c.docx")
      expect(problemCounts(reader, config())).toMatchObject([{ category: "unreadable", count: 3 }])
    } finally {
      reader.close()
      writer.close()
    }
  })

  test("files there was no reader for are not offered to read again", () => {
    const own = openDb(":memory:")
    try {
      const add = (rel: string, ext: string, kind: string, note: string) =>
        own.query("INSERT INTO files(path, name, ext, kind, content_state, note) VALUES (?, ?, ?, ?, ?, ?)").run(at(rel), rel.split("/").pop()!, ext, kind, ContentState.Skipped, note)
      add("Documents/blank.pdf", "pdf", "pdf", "empty")
      add("Documents/unread.pdf", "pdf", "pdf", "unsupported")
      add("Pictures/photo.jpg", "jpg", "image", "unsupported")
      const by = new Map(listProblems(own, config()).problems.map((p) => [p.path, p]))
      expect(by.get(at("Documents/blank.pdf"))).toMatchObject({ category: "no-text", retry: true })
      expect(by.get(at("Documents/unread.pdf"))).toMatchObject({ category: "no-text", retry: false })
      expect(by.get(at("Pictures/photo.jpg"))).toMatchObject({ category: "no-text", retry: false, setting: "content.ocr" })
      expect(explainPath(own, config(), at("Pictures/photo.jpg")).retry).toBe(false)
      expect(problemCounts(own, config())).toEqual([{ category: "no-text", label: "No text found", count: 3, retry: true }])

      // Only the file nothing was found in is read again.
      expect(retryProblems(own, config(), { category: "no-text" }).retried).toBe(1)
      const state = (rel: string) => (own.query("SELECT content_state AS s FROM files WHERE path = ?").get(at(rel)) as { s: number }).s
      expect([state("Documents/blank.pdf"), state("Documents/unread.pdf"), state("Pictures/photo.jpg")]).toEqual([ContentState.Pending, ContentState.Skipped, ContentState.Skipped])
      expect(problemCounts(own, config())).toEqual([{ category: "no-text", label: "No text found", count: 2, retry: false }])
      const refused = retryProblems(own, config(), { paths: [at("Pictures/photo.jpg")] })
      expect(refused.retried).toBe(0)
      expect(refused.refused[0]!.reason).toContain("OCR")
    } finally {
      own.close()
    }
  })

  test("problem counts are kept until the index or the settings change", () => {
    const path = join(corpus.home, "cached.db")
    const reader = openDb(path)
    const writer = openDb(path)
    try {
      const add = (db: Database, rel: string) => db.query("INSERT INTO files(path, name, ext, kind, content_state, note) VALUES (?, ?, 'docx', 'doc', ?, ?)").run(at(rel), rel, ContentState.Error, "corrupt piece table")
      const count = (c = config()) => problemCounts(reader, c).map((k) => [k.category, k.count])
      add(writer, "one.docx")
      expect(count()).toEqual([["unreadable", 1]])

      // Kept: without the trigger that records changes, a change goes unseen until the next one recorded.
      reader.exec("DROP TRIGGER files_insert_seq")
      add(reader, "two.docx")
      expect(count()).toEqual([["unreadable", 1]])

      // Another process changing the index.
      writer.query("UPDATE files SET note = 'took too long: timed out' WHERE path = ?").run(at("one.docx"))
      expect(count()).toEqual([["unreadable", 1], ["timeout", 1]])
      // A file removed, as an index update removes them.
      writer.transaction(() => {
        const { id } = writer.query("SELECT id FROM files WHERE path = ?").get(at("one.docx")) as { id: number }
        writer.query("DELETE FROM files WHERE id = ?").run(id)
        writer.query("INSERT INTO removed(id) VALUES (?)").run(id)
      })()
      expect(count()).toEqual([["unreadable", 1]])

      // Settings: a names-only folder now holds a document that is not read.
      writer.query("INSERT INTO files(path, name, ext, kind, content_state) VALUES (?, 'old.docx', 'docx', 'doc', ?)").run(at("Attic/old.docx"), ContentState.None)
      expect(count()).toEqual([["unreadable", 1]])
      const attic = config()
      attic.namesOnly = ["~/Attic"]
      expect(count(attic)).toEqual([["unreadable", 1], ["names-only", 1]])
      expect(listProblems(reader, attic, { categories: ["names-only"] }).problems.map((p) => p.path)).toEqual([at("Attic/old.docx")])
    } finally {
      reader.close()
      writer.close()
    }
  })
})
