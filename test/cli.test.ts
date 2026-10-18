import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs, progressLine } from "../src/cli.ts"
import { acquireLock } from "../src/index/lock.ts"
import { makeCorpus } from "./helpers/corpus.ts"

let corpus: ReturnType<typeof makeCorpus>
const MAIN = join(import.meta.dir, "..", "src", "main.ts")

beforeAll(() => {
  corpus = makeCorpus()
})
afterAll(() => corpus.cleanup())

async function zs(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    cwd: corpus.home,
    env: { ...process.env, HOME: corpus.home, ZSEARCH_HOME: join(corpus.home, ".zsearch-data"), NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out, err }
}

describe("argument parsing", () => {
  test("flags, values and positionals", () => {
    const a = parseArgs(["search", "-m", "regex", "--limit=5", "foo", "-lq", "--no-color", "--", "-x"])
    expect(a._).toEqual(["search", "foo", "-x"])
    expect(a.flags.get("m")).toBe("regex")
    expect(a.flags.get("limit")).toBe("5")
    expect(a.flags.get("l")).toBe(true)
    expect(a.flags.get("q")).toBe(true)
    expect(a.flags.get("color")).toBe(false)
  })

  test("progress lines", () => {
    const base = { scanned: 10, added: 0, updated: 0, removed: 0, contentTotal: 4, contentDone: 1, contentBytes: 2048, contentErrors: 0, current: "", startedAt: 0, elapsedMs: 1500 }
    expect(progressLine({ ...base, phase: "content" })).toContain("Word index: reading contents 25%")
    expect(progressLine({ ...base, phase: "meaning", meaning: { total: 4, done: 1, embedded: 3, reused: 2 } })).toContain("Semantic index (Granite) 25%")
    expect(progressLine({ ...base, phase: "scan" })).toContain("Scanning… 10 items")
  })
})

describe("zsearch command line", () => {
  test("--help and --version", async () => {
    const h = await zs("--help")
    expect(h.code).toBe(0)
    expect(h.out).toContain("zsearch search <query>")
    expect(h.out).toContain("Query syntax")
    const v = await zs("--version")
    expect(v.out.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test("index --semantic-only without semantic search on explains and builds nothing", async () => {
    const r = await zs("index", "--semantic-only")
    expect(r.code).toBe(1)
    expect(r.err).toContain("semantic search cannot run")
    const both = await zs("index", "--meaning-only", "--rebuild")
    expect(both.code).not.toBe(0)
    expect(both.err).toContain("--semantic-only cannot be combined with --rebuild")
  })

  test("search before indexing explains what to do", async () => {
    const r = await zs("search", "budget")
    expect(r.code).toBe(2)
    expect(r.err).toContain("zsearch index")
  })

  test("index builds the index and saves the config", async () => {
    const r = await zs("index")
    expect(r.code).toBe(0)
    expect(r.err).toContain("Done in")
    expect(r.err).toMatch(/Index: \d+ files/)
    expect(existsSync(join(corpus.home, ".zsearch-data", "index.db"))).toBe(true)
    const roots = () => JSON.parse(readFileSync(join(corpus.home, ".zsearch-data", "config.json"), "utf8")).roots
    // Documents and Downloads by default
    expect(roots()).toEqual(["~/Documents", "~/Downloads"])
    expect((await zs("search", "-l", "zanzibar")).out).toContain(join(corpus.home, "Downloads", "unknown-text-file"))
    expect((await zs("search", "-l", "pancakes")).code).toBe(1)
    // --home switches to the whole home folder
    expect((await zs("index", "--home", "--quiet")).code).toBe(0)
    expect(roots()).toEqual(["~"])
    expect((await zs("search", "-l", "pancakes")).out).toContain(join(corpus.home, "notes", "recipes", "pancakes.txt"))
  })

  test("search prints matches with line numbers", async () => {
    const r = await zs("search", "budget")
    expect(r.code).toBe(0)
    const lines = r.out.split("\n")
    expect(lines[0]).toContain("Documents/budget.xlsx")
    expect(r.out).toContain("The marketing budget for the northern region")
  })

  test("search modes, JSON and paths-only output", async () => {
    const regex = await zs("search", "--regex", "MAX_\\w+")
    expect(regex.code).toBe(0)
    expect(regex.out).toContain("MAX_RETRIES = 42")
    const json = await zs("search", "--json", "calvin")
    const parsed = JSON.parse(json.out)
    expect(parsed.hits[0].path).toEndWith("Documents/paper.pdf")
    expect(parsed.hits[0].lines[0].page).toBe(2)
    const files = await zs("search", "-l", "type:slides")
    expect(files.out.trim().split("\n").sort()).toEqual(
      [join(corpus.home, "Documents/deck.pptx"), join(corpus.home, "Documents/old/basic_test_ppt_file.ppt"), join(corpus.home, "Documents/slides.odp")].sort(),
    )
  })

  test("no matches exits 1; bad regex and bad mode exit 2", async () => {
    expect((await zs("search", "qqqzzzxxyy")).code).toBe(1)
    const bad = await zs("search", "re:foo(")
    expect(bad.code).toBe(2)
    expect(bad.err).toContain("invalid regex")
    expect((await zs("search", "-m", "nonsense", "x")).code).toBe(2)
    expect((await zs("search", "-m", "regex", "x")).code).toBe(2)
  })

  test("command help, NUL/CSV output, sorting and negated CLI filters", async () => {
    expect((await zs("search", "--help")).out).toContain("--csv")
    expect((await zs("duplicates", "--help")).out).toContain("duplicates [--json]")
    const nul = await zs("search", "-0", "type:slides", "--sort", "name")
    expect(nul.code).toBe(0)
    expect(nul.out.endsWith("\0")).toBe(true)
    expect(nul.out.slice(0, -1).split("\0")).toHaveLength(3)
    const csv = await zs("search", "--csv", "name:paper.pdf")
    expect(csv.code).toBe(0)
    expect(csv.out.split("\n")[0]).toBe("path,kind,size,mtime,match_count")
    expect(csv.out).toContain('"' + join(corpus.home, "Documents/paper.pdf") + '","pdf",')
    const inverse = await zs("search", "--json", "budget", "-ext:xlsx")
    expect(JSON.parse(inverse.out).hits.every((h: { path: string }) => !h.path.endsWith(".xlsx"))).toBe(true)
    expect((await zs("duplicates", "--json")).code).toBe(0)
  })

  test("status and doctor", async () => {
    const s = await zs("status")
    expect(s.code).toBe(0)
    expect(s.out).toMatch(/Files\s+\d+ files, \d+ folders/)
    const d = await zs("doctor")
    expect(d.code).toBe(0)
    expect(d.out).toContain("FTS5")
  })

  test("indexing problems: status --errors, why and retry", async () => {
    corpus.write("Documents/broken.docx", "not really a docx")
    expect((await zs("index", "--quiet")).code).toBe(0)
    const s = await zs("status", "--errors")
    expect(s.code).toBe(0)
    expect(s.out).toContain("Could not be read (1) · zsearch retry unreadable")
    expect(s.out).toContain("It is not in the format its name suggests, or it is damaged.")
    expect(s.out).toContain("~/Documents/broken.docx (not a valid Office file")
    const only = await zs("status", "--errors=secret", "--json")
    expect(JSON.parse(only.out).problems.every((p: { category: string }) => p.category === "secret")).toBe(true)
    expect((await zs("status", "--errors=bogus")).code).toBe(2)

    const why = await zs("why", "~/Documents/broken.docx")
    expect(why.out).toContain("only its name is searchable")
    expect(why.out).toContain('zsearch retry "~/Documents/broken.docx"')
    expect(JSON.parse((await zs("why", "--json", "~/notes/recipes/pancakes.txt")).out).searchable).toBe("content")
    // Several files: each is explained, not one path made of them all.
    const both = await zs("why", "~/notes/recipes/pancakes.txt", "~/Documents/broken.docx")
    expect(both.code).toBe(0)
    expect(both.out).toContain("~/notes/recipes/pancakes.txt: its name and text are searchable.")
    expect(both.out).toContain("~/Documents/broken.docx: only its name is searchable.")
    const json = JSON.parse((await zs("why", "--json", "~/notes/recipes/pancakes.txt", "~/Documents/broken.docx")).out) as { searchable: string }[]
    expect(json.map((e) => e.searchable)).toEqual(["content", "name"])

    expect((await zs("retry", "secret")).err).toContain("never read")
    const retry = await zs("retry", "unreadable", "--quiet")
    expect(retry.code).toBe(0)
    expect(retry.err).toContain("1 file is read again with the next index update.")
    expect((await zs("retry", "~/notes/recipes/pancakes.txt")).code).toBe(1)
  })

  test("retry while another process holds the lock says the files wait for it", async () => {
    corpus.write("Documents/stuck.docx", "not really a docx")
    expect((await zs("index", "--quiet")).code).toBe(0)
    // Held from here, as another zsearch process would hold it.
    const release = acquireLock(join(corpus.home, ".zsearch-data", "index.lock"))!
    try {
      const r = await zs("retry", "unreadable")
      expect(r.code).toBe(0)
      expect(r.err).toContain("read again with the next index update")
      expect(r.err).toContain("is updating the index")
    } finally {
      release()
    }
  })

  test("config get/set/path with validation", async () => {
    expect((await zs("config", "set", "includeHidden", "true")).code).toBe(0)
    expect((await zs("config", "get", "includeHidden")).out.trim()).toBe("true")
    expect((await zs("config", "set", "content.maxTextMB", "4")).code).toBe(0)
    expect((await zs("config", "get", "content.maxTextMB")).out.trim()).toBe("4")
    const bad = await zs("config", "set", "nope", "1")
    expect(bad.code).toBe(2)
    expect(bad.err).toContain("unknown config key")
    expect((await zs("config", "set", "includeHidden", "maybe")).code).toBe(2)
    expect((await zs("config", "path")).out.trim()).toEndWith("config.json")
  })

  test("index a specific folder, then reset", async () => {
    const r = await zs("index", join(corpus.home, "notes"), "--quiet")
    expect(r.code).toBe(0)
    expect((await zs("search", "-l", "budget")).out).not.toContain("Documents")
    expect((await zs("index", "/does/not/exist")).code).toBe(2)
    const reset = await zs("reset")
    expect(reset.code).toBe(0)
    expect(existsSync(join(corpus.home, ".zsearch-data", "index.db"))).toBe(false)
  })
})
