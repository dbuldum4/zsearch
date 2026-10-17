import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { App } from "../src/tui/app.tsx"
import { clearRecent, deleteSearch, findSaved, loadSearches, RECENT_LIMIT, rememberSearch, renameSearch, saveSearch, searchesFile } from "../src/searches.ts"
import { homeConfig, makeCorpus } from "./helpers/corpus.ts"
import { testServices } from "./helpers/services.ts"

let corpus: ReturnType<typeof makeCorpus>
const MAIN = join(import.meta.dir, "..", "src", "main.ts")
const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME }

beforeAll(() => {
  corpus = makeCorpus()
  process.env.HOME = corpus.home
  process.env.ZSEARCH_HOME = join(corpus.home, ".zsearch-data")
})

afterAll(() => {
  corpus.cleanup()
  process.env.HOME = env.HOME
  if (env.ZSEARCH_HOME === undefined) delete process.env.ZSEARCH_HOME
  else process.env.ZSEARCH_HOME = env.ZSEARCH_HOME
})

describe("saved searches and history", () => {
  beforeEach(() => rmSync(searchesFile(), { force: true }))

  test("save, replace, rename and delete by name", () => {
    expect(loadSearches()).toEqual({ saved: [], recent: [] })
    saveSearch("Recent invoices", "invoice type:pdf mtime:<30d", "find")
    saveSearch("large downloads", "in:~/Downloads size:>100mb sort:-size", "find")
    let s = saveSearch("  Project   notes ", "f:notes", "fuzzy")
    expect(s.saved.map((e) => e.name)).toEqual(["large downloads", "Project notes", "Recent invoices"])
    // The same name in other case replaces it.
    s = saveSearch("recent INVOICES", "invoice type:pdf mtime:<7d", "find")
    expect(s.saved).toHaveLength(3)
    expect(findSaved(s, "Recent Invoices")).toEqual({ name: "recent INVOICES", query: "invoice type:pdf mtime:<7d", mode: "find" })
    expect(() => renameSearch("project notes", "Large Downloads")).toThrow('already called "large downloads"')
    expect(() => renameSearch("nothing", "x")).toThrow("no saved search")
    s = renameSearch("project notes", "Notes")
    expect(findSaved(s, "notes")?.query).toBe("f:notes")
    // Renaming to the same name in other case is allowed.
    expect(findSaved(renameSearch("notes", "NOTES"), "notes")?.name).toBe("NOTES")
    s = deleteSearch("LARGE downloads")
    expect(s.saved.map((e) => e.name)).toEqual(["NOTES", "recent INVOICES"])
    expect(loadSearches()).toEqual(s)
    expect(() => saveSearch("", "x", "find")).toThrow("needs a name")
    expect(() => saveSearch("Empty", "   ", "find")).toThrow("no search to save")
    expect(() => saveSearch("Bad", "x", "regex" as never)).toThrow('unknown mode "regex"')
  })

  test("history keeps committed searches, newest first, once each, bounded", () => {
    rememberSearch("budget", "find", 1000)
    rememberSearch("  ", "find", 1500)
    rememberSearch("report", "fuzzy", 2000)
    let s = rememberSearch("budget", "fuzzy", 3000)
    expect(s.recent).toEqual([
      { query: "budget", mode: "fuzzy", at: 3000 },
      { query: "report", mode: "fuzzy", at: 2000 },
    ])
    for (let i = 0; i < RECENT_LIMIT + 10; i++) rememberSearch(`query ${i}`, "find", 10_000 + i)
    s = loadSearches()
    expect(s.recent).toHaveLength(RECENT_LIMIT)
    expect(s.recent[0]!.query).toBe(`query ${RECENT_LIMIT + 9}`)
    expect(clearRecent().recent).toEqual([])
    expect(loadSearches().recent).toEqual([])
  })

  test("the file is private and a damaged one reads as empty", () => {
    saveSearch("Mine", "secret plans", "find")
    expect(statSync(searchesFile()).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(searchesFile())).mode & 0o777).toBe(0o700)
    writeFileSync(searchesFile(), JSON.stringify({
      saved: [{ name: "ok", query: "a", mode: "find" }, { name: "", query: "b", mode: "find" }, { name: "bad mode", query: "c", mode: "regex" }, "junk"],
      recent: [{ query: "x", mode: "find", at: 5 }, { query: "x", mode: "fuzzy", at: 4 }, { query: 3, mode: "find" }],
    }))
    expect(loadSearches()).toEqual({ saved: [{ name: "ok", query: "a", mode: "find" }], recent: [{ query: "x", mode: "find", at: 5 }] })
    writeFileSync(searchesFile(), "{ not json")
    const warn = process.emitWarning
    process.emitWarning = () => {}
    try {
      expect(loadSearches()).toEqual({ saved: [], recent: [] })
      // Saving over a damaged file starts it again.
      expect(saveSearch("Fresh", "a", "find").saved).toHaveLength(1)
    } finally { process.emitWarning = warn }
  })
})

async function zs(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    cwd: corpus.home,
    env: { ...process.env, HOME: corpus.home, ZSEARCH_HOME: join(corpus.home, ".zsearch-cli"), NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out, err }
}

test("command line: saved add, list, run, rename, rm and history", async () => {
  expect((await zs("saved")).out).toContain("No saved searches")
  expect((await zs("index", "-q")).code).toBe(0)
  const add = await zs("saved", "add", "Odd downloads", "zanzibar", "in:~/Downloads", "-m", "find")
  expect(add.code).toBe(0)
  expect(add.out).toContain('Saved "Odd downloads": zanzibar in:~/Downloads (find)')
  expect((await zs("saved", "add", "Fuzzy budget", "budget", "--mode", "fuzzy")).code).toBe(0)
  const list = await zs("saved", "list")
  expect(list.out.trim().split("\n")).toEqual(["Fuzzy budget   fuzzy     budget", "Odd downloads  find      zanzibar in:~/Downloads"])
  expect(JSON.parse((await zs("saved", "--json")).out)).toHaveLength(2)
  const run = await zs("saved", "run", "odd downloads", "-l")
  expect(run.code).toBe(0)
  expect(run.out).toContain(join(corpus.home, "Downloads", "unknown-text-file"))
  expect((await zs("saved", "run", "missing")).err).toContain('no saved search is called "missing"')
  expect((await zs("saved", "rename", "Odd downloads", "Zanzibar")).out).toContain('Renamed "Odd downloads" to "Zanzibar"')
  expect((await zs("saved", "rm", "fuzzy BUDGET")).out).toContain('Deleted "Fuzzy budget"')
  expect((await zs("saved")).out.trim()).toBe("Zanzibar  find      zanzibar in:~/Downloads")
  expect((await zs("saved", "frobnicate")).code).toBe(2)
  expect((await zs("history")).out).toContain("No searches yet")
}, 60_000)

test("serve: saved searches and history over JSON lines", async () => {
  const proc = Bun.spawn(["bun", MAIN, "serve"], {
    cwd: corpus.home,
    env: { ...process.env, HOME: corpus.home, ZSEARCH_HOME: join(corpus.home, ".zsearch-serve") },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const next = async (): Promise<Record<string, any>> => {
    for (;;) {
      const nl = buffer.indexOf("\n")
      if (nl >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        return JSON.parse(line)
      }
      const { value, done } = await reader.read()
      if (done) throw new Error("server closed stdout")
      buffer += decoder.decode(value, { stream: true })
    }
  }
  const ask = async (m: Record<string, unknown>) => {
    proc.stdin.write(JSON.stringify(m) + "\n")
    proc.stdin.flush()
    for (;;) {
      const reply = await next()
      if (reply.id === m.id) return reply
    }
  }
  try {
    while ((await next()).type !== "ready");
    expect(await ask({ id: 1, type: "searches" })).toEqual({ id: 1, type: "searches", saved: [], recent: [] })
    const saved = await ask({ id: 2, type: "saveSearch", name: "Recent invoices", query: "invoice type:pdf mtime:<30d", mode: "find" })
    expect(saved.saved).toEqual([{ name: "Recent invoices", query: "invoice type:pdf mtime:<30d", mode: "find" }])
    expect((await ask({ id: 3, type: "renameSearch", name: "recent invoices", to: "Invoices" })).saved[0].name).toBe("Invoices")
    expect(await ask({ id: 4, type: "renameSearch", name: "nothing", to: "x" })).toEqual({ id: 4, type: "error", error: 'no saved search is called "nothing"' })
    await ask({ id: 5, type: "rememberSearch", query: "budget", mode: "fuzzy" })
    const remembered = await ask({ id: 6, type: "rememberSearch", query: "report", mode: "find" })
    expect(remembered.recent.map((r: { query: string; mode: string }) => [r.query, r.mode])).toEqual([["report", "find"], ["budget", "fuzzy"]])
    expect((await ask({ id: 7, type: "deleteSearch", name: "Invoices" })).saved).toEqual([])
    expect((await ask({ id: 8, type: "clearRecent" })).recent).toEqual([])
    expect(existsSync(join(corpus.home, ".zsearch-serve", "searches.json"))).toBe(true)
    proc.stdin.end()
    expect(await proc.exited).toBe(0)
  } finally { proc.kill() }
}, 30_000)

test("terminal app: opening a result keeps its search; Alt-↑/↓ step through earlier ones", async () => {
  type Setup = Awaited<ReturnType<typeof testRender>>
  const until = async (s: Setup, pred: (frame: string) => boolean, timeoutMs = 8000) => {
    const end = Date.now() + timeoutMs
    let frame = ""
    while (Date.now() < end) {
      await s.renderOnce()
      frame = s.captureCharFrame()
      if (pred(frame)) return frame
      await Bun.sleep(25)
    }
    throw new Error(`condition not met; last frame:\n${frame}`)
  }
  const type = async (s: Setup, text: string) => {
    for (const ch of text) {
      s.mockInput.pressKey(ch)
      await Bun.sleep(5)
    }
  }
  const clear = async (s: Setup) => {
    s.mockInput.pressEscape()
    await Bun.sleep(120)
    await until(s, (f) => f.includes("❯ Search names"))
  }
  mkdirSync(join(corpus.home, ".zsearch-tui"), { recursive: true })
  const t = testServices(homeConfig(), { dbPath: join(corpus.home, ".zsearch-tui", "index.db") })
  await t.services.startIndex(homeConfig(), {}).done
  t.resetEngine()
  const s = await testRender(() => <App services={t.services} />, { width: 120, height: 32 })
  try {
    await until(s, (f) => f.includes("Start typing") || f.includes("results"))
    s.mockInput.pressArrow("up", { meta: true })
    await until(s, (f) => f.includes("No recent searches yet"))
    await type(s, "pancakes")
    await until(s, (f) => f.includes("pancakes.txt"))
    s.mockInput.pressEnter()
    await until(s, (f) => f.includes("Opened"))
    await clear(s)
    s.mockInput.pressTab()
    await type(s, "zanzibar")
    await until(s, (f) => f.includes("unknown-text-file") && f.includes(" FUZZY "))
    s.mockInput.pressKey("o", { ctrl: true })
    await Bun.sleep(50)
    expect(t.calls.recent.map((r) => [r.query, r.mode])).toEqual([["zanzibar", "fuzzy"], ["pancakes", "find"]])
    await clear(s)
    s.mockInput.pressTab()
    await type(s, "draft")
    await until(s, (f) => f.includes("❯ draft") && f.includes(" SEMANTIC "))
    s.mockInput.pressArrow("up", { meta: true })
    await until(s, (f) => f.includes("❯ zanzibar") && f.includes(" FUZZY ") && f.includes("Recent search 1 of 2"))
    s.mockInput.pressArrow("up", { meta: true })
    await until(s, (f) => f.includes("❯ pancakes") && f.includes(" FIND ") && f.includes("pancakes.txt"))
    s.mockInput.pressArrow("down", { meta: true })
    await until(s, (f) => f.includes("❯ zanzibar"))
    s.mockInput.pressArrow("down", { meta: true })
    await until(s, (f) => f.includes("❯ draft") && f.includes(" SEMANTIC ") && f.includes("Back to your search"))
  } finally {
    s.renderer.destroy()
    t.close()
  }
}, 30_000)
