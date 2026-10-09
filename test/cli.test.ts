import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs, progressLine } from "../src/cli.ts"
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
    expect(progressLine({ ...base, phase: "content" })).toContain("Reading contents 25%")
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
    const regex = await zs("search", "-m", "regex", "MAX_\\w+")
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
    const bad = await zs("search", "-m", "regex", "foo(")
    expect(bad.code).toBe(2)
    expect(bad.err).toContain("invalid regex")
    expect((await zs("search", "-m", "nonsense", "x")).code).toBe(2)
  })

  test("status and doctor", async () => {
    const s = await zs("status")
    expect(s.code).toBe(0)
    expect(s.out).toMatch(/Files\s+\d+ files, \d+ folders/)
    const d = await zs("doctor")
    expect(d.code).toBe(0)
    expect(d.out).toContain("FTS5")
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
