import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { join } from "node:path"
import type { Config } from "../src/config.ts"
import { openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine, type SearchResponse } from "../src/search/engine.ts"
import type { Mode } from "../src/search/query.ts"
import { makeCorpus, homeConfig } from "./helpers/corpus.ts"

let corpus: ReturnType<typeof makeCorpus>
let db: Database
let engine: SearchEngine
let config: Config
const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME }

beforeAll(async () => {
  corpus = makeCorpus()
  process.env.HOME = corpus.home
  process.env.ZSEARCH_HOME = join(corpus.home, ".zsearch-data")
  // A few extra files that exercise ranking.
  corpus.write("code/app/src/main.rs", 'fn main() {\n    println!("hello");\n}\n')
  corpus.write("code/app/src/receive.py", "def receive(packet):\n    return packet\n")
  corpus.write("notes/meeting-2024-05.md", "Meeting notes\nPhone: 555-1234\nAction: email Anna about the budget.\n")
  db = openDb(join(corpus.home, ".zsearch-data", "index.db"))
  config = homeConfig()
  await new Indexer(db, config, { inProcess: true }).run()
  engine = new SearchEngine(db, config)
})

afterAll(() => {
  db.close()
  corpus.cleanup()
  process.env.HOME = env.HOME
  if (env.ZSEARCH_HOME === undefined) delete process.env.ZSEARCH_HOME
  else process.env.ZSEARCH_HOME = env.ZSEARCH_HOME
})

const search = (q: string, mode: Mode = "auto", limit = 50) => engine.search(q, mode, { limit })
const names = (r: SearchResponse) => r.hits.map((h) => h.display)

describe("auto mode", () => {
  test("file name and content matches are combined; the named file ranks first", async () => {
    const r = await search("budget")
    expect(r.error).toBeUndefined()
    expect(names(r)[0]).toBe("Documents/budget.xlsx")
    expect(names(r)).toContain("Documents/report.docx")
    expect(names(r)).toContain("Documents/deck.pptx")
    expect(r.strategy).toContain("names + text")
    const docx = r.hits.find((h) => h.display === "Documents/report.docx")!
    expect(docx.sources).toContain("content")
    expect(docx.lines[0]!.text).toContain("marketing budget")
    const [a, b] = docx.lines[0]!.ranges[0]!
    expect(docx.lines[0]!.text.slice(a, b).toLowerCase()).toBe("budget")
  })

  test("search as you type matches word prefixes", async () => {
    const r = await search("photosynth")
    expect(names(r)).toContain("Documents/paper.pdf")
  })

  test("accents and case are ignored", async () => {
    const r = await search("CAFE")
    expect(names(r)).toEqual(expect.arrayContaining(["Documents/letter.rtf", "Documents/report.docx", "Documents/mail.eml"]))
  })

  test("all words must match, in any order and across name and text", async () => {
    const r = await search("lisbon passport ")
    expect(names(r)[0]).toBe("notes/todo.md")
    const r2 = await search("calvin paper ")
    expect(names(r2)[0]).toBe("Documents/paper.pdf")
  })

  test("falls back to any word when no file has all of them", async () => {
    const r = await search("glacier xylophone ")
    expect(names(r)).toContain("notes/journal-2024.md")
  })

  test("typos are forgiven when nothing matches exactly", async () => {
    const r = await search("photosynthesus ")
    expect(names(r)).toContain("Documents/paper.pdf")
    expect(r.strategy).toContain("typo")
  })

  test("page numbers for PDF hits", async () => {
    const r = await search("calvin ")
    const pdf = r.hits.find((h) => h.display === "Documents/paper.pdf")!
    expect(pdf.lines[0]!.page).toBe(2)
  })

  test("regex-looking queries run as regex", async () => {
    const r = await search("\\d{3}-\\d{4}")
    expect(r.resolved).toBe("regex")
    expect(names(r)).toContain("notes/meeting-2024-05.md")
  })

  test("quoted phrase is exact", async () => {
    const r = await search('"twelve percent"')
    expect(r.resolved).toBe("exact")
    expect(names(r)).toEqual(["Documents/report.docx"])
    expect(r.hits[0]!.lines[0]!.line).toBe(2)
  })

  test("negation excludes files", async () => {
    const r = await search("budget !marketing ")
    expect(names(r)).not.toContain("Documents/report.docx")
    expect(names(r)).toContain("Documents/deck.pptx")
  })

  test("empty query lists recent files", async () => {
    const r = await search("")
    expect(r.hits.length).toBeGreaterThan(5)
    expect(r.hits.every((h) => !h.isDir)).toBe(true)
  })
})

describe("filters", () => {
  test("ext:, type:, in: and path:", async () => {
    expect(names(await search("budget ext:pptx"))).toEqual(["Documents/deck.pptx"])
    expect(names(await search("type:pdf"))).toEqual(["Documents/paper.pdf"])
    const inNotes = names(await search("in:notes"))
    expect(inNotes.length).toBeGreaterThan(2)
    expect(inNotes.every((p) => p.startsWith("notes/"))).toBe(true)
    // Filter-only queries list newest first; the folder and its file can share a timestamp.
    expect(names(await search("path:recipes")).sort()).toEqual(["notes/recipes", "notes/recipes/pancakes.txt"])
    expect(names(await search("type:folder in:code"))).toEqual(expect.arrayContaining(["code/app", "code/app/src"]))
  })

  test("size and modification time", async () => {
    expect(names(await search("mtime:<1d type:md"))).not.toContain("notes/journal-2024.md")
    expect(names(await search("before:2025-01-01"))).toEqual(["notes/journal-2024.md"])
    const big = names(await search("size:>20kb"))
    expect(big).toEqual(expect.arrayContaining(["Documents/report.docx", "Documents/deck.pptx"]))
    expect(big).not.toContain("notes/todo.md")
  })

  test("limit:", async () => {
    expect((await search("type:doc limit:2")).hits).toHaveLength(2)
  })
})

describe("fuzzy mode", () => {
  test("fzf-style subsequence matching on paths", async () => {
    const r = await search("srvts", "fuzzy")
    expect(names(r)[0]).toBe("code/app/src/server.ts")
    expect(r.hits[0]!.namePositions.length).toBe(5)
  })

  test("transposed letters still find the file", async () => {
    expect(names(await search("mian", "fuzzy"))).toContain("code/app/src/main.rs")
    expect(names(await search("recieve", "fuzzy"))).toContain("code/app/src/receive.py")
  })

  test("fzf operators", async () => {
    expect(names(await search(".rs$", "fuzzy"))).toEqual(["code/app/src/main.rs"])
    expect(names(await search("^serv", "fuzzy"))).toEqual(["code/app/src/server.ts"])
    expect(names(await search("'app !src", "fuzzy")).every((p) => !p.includes("src"))).toBe(true)
  })

  test("typo-tolerant content matches", async () => {
    const r = await search("glaicer", "fuzzy")
    expect(names(r)).toContain("notes/journal-2024.md")
  })
})

describe("exact and regex modes", () => {
  test("exact is a literal, smart-case substring search", async () => {
    const r = await search("UserName", "exact")
    expect(names(r)).toContain("code/app/src/server.ts")
    const hit = r.hits.find((h) => h.display === "code/app/src/server.ts")!
    expect(hit.lines[0]!.line).toBe(3)
    expect((await search("USERNAME", "exact")).hits.filter((h) => h.sources.includes("content"))).toHaveLength(0)
    expect(names(await search("username", "exact"))).toContain("code/app/src/server.ts")
  })

  test("exact matches special characters literally", async () => {
    const r = await search("user_${id}", "exact")
    expect(names(r)).toContain("code/app/src/server.ts")
  })

  test("regex over contents with line numbers", async () => {
    const r = await search("MAX_\\w+ = \\d+", "regex")
    expect(names(r)).toEqual(["code/app/src/util/parse_config.py"])
    expect(r.hits[0]!.lines[0]).toMatchObject({ line: 7, text: "MAX_RETRIES = 42" })
    expect(r.strategy).toContain("indexed")
  })

  test("regex with alternation and no literal prefix", async () => {
    const r = await search("(flour|glacier)", "regex")
    expect(names(r).sort()).toEqual(["notes/journal-2024.md", "notes/recipes/pancakes.txt"])
    const r2 = await search("^\\s+return", "regex")
    expect(names(r2)).toEqual(expect.arrayContaining(["code/app/src/server.ts", "code/app/src/receive.py"]))
  })

  test("regex also matches file names", async () => {
    const r = await search("journal-\\d+", "regex")
    expect(names(r)).toContain("notes/journal-2024.md")
    expect(r.hits[0]!.sources).toContain("name")
  })

  test("invalid regex reports an error", async () => {
    const r = await search("foo(", "regex")
    expect(r.error).toMatch(/invalid regex/)
  })
})

describe("preview", () => {
  test("text with highlights around the first match", async () => {
    const r = await search("calvin ")
    const pdf = r.hits.find((h) => h.display === "Documents/paper.pdf")!
    const p = engine.preview(pdf.id, "calvin ", "auto")
    expect(p.focusLine).toBe(pdf.lines[0]!.line)
    expect(p.pageStarts.length).toBe(2)
    const line = p.lines.find((l) => l.n === p.focusLine)!
    expect(line.text.slice(line.ranges[0]![0], line.ranges[0]![1])).toBe("Calvin")
  })

  test("folders list their contents", async () => {
    const r = await search("type:folder recipes")
    const p = engine.preview(r.hits[0]!.id, "", "auto")
    expect(p.isDir).toBe(true)
    expect(p.lines.map((l) => l.text)).toContain("pancakes.txt")
  })

  test("binary files explain why there is no preview", async () => {
    const r = await search("holiday-beach")
    const p = engine.preview(r.hits[0]!.id, "", "auto")
    expect(p.message).toBe("no text preview for this kind of file")
  })
})

describe("live updates and frecency", () => {
  test("new files are found after the indexer commits", async () => {
    corpus.write("notes/fresh.txt", "a freshly written zeppelin note")
    expect((await search("zeppelin ")).hits).toHaveLength(0)
    await new Indexer(db, config, { inProcess: true }).run()
    expect(names(await search("zeppelin "))).toEqual(["notes/fresh.txt"])
  })

  test("opened files rank higher next time", async () => {
    const first = await search("notes", "fuzzy")
    const before = names(first)
    const nameHits = first.hits.filter((h) => h.sources.includes("name"))
    const target = nameHits[nameHits.length - 1]!.display
    for (let i = 0; i < 5; i++) engine.recordOpen(join(corpus.home, target))
    const after = names(await search("notes", "fuzzy"))
    expect(after.indexOf(target)).toBeLessThan(before.indexOf(target))
    expect(names(await search(""))[0]).toBe(target)
  })
})
