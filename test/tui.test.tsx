import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { defaultConfig } from "../src/config.ts"
import { lockHolder } from "../src/index/lock.ts"
import { App } from "../src/tui/app.tsx"
import { realServices } from "../src/tui/services.ts"
import { makeCorpus, homeConfig } from "./helpers/corpus.ts"
import { testServices } from "./helpers/services.ts"

let corpus: ReturnType<typeof makeCorpus>
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

type Setup = Awaited<ReturnType<typeof testRender>>

/** Render frames until `pred` holds (the app works asynchronously: workers, timers). */
async function until(s: Setup, pred: (frame: string) => boolean, timeoutMs = 8000): Promise<string> {
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

/** Esc followed too quickly by a key reads as Alt+key (as in a real terminal): wait a little. */
async function esc(s: Setup) {
  s.mockInput.pressEscape()
  await Bun.sleep(120)
  await s.renderOnce()
}

/** File names in the result list, top to bottom. */
function listed(frame: string): string[] {
  return frame.split("\n").flatMap((l) => /^[▌ ][A-Z]+\s+(\S+)/.exec(l)?.[1] ?? [])
}

async function type(s: Setup, text: string) {
  for (const ch of text) {
    s.mockInput.pressKey(ch)
    await Bun.sleep(5)
  }
}

describe("first run", () => {
  test("setup screen, indexing, then live search", async () => {
    const t = testServices(defaultConfig(), { firstRun: true })
    let exited: string | null | undefined
    const s = await testRender(() => <App services={t.services} onExit={(sel) => (exited = sel)} />, { width: 120, height: 32 })
    try {
      const welcome = await until(s, (f) => f.includes("Welcome to zsearch"))
      expect(welcome).toContain("(•) Documents and Downloads")
      expect(welcome).toContain("Home folder")
      expect(welcome).toContain("Search inside files")
      expect(welcome).toContain("Start indexing")
      // Toggle "include hidden" (cursor starts on the button: go up 2) and start.
      s.mockInput.pressArrow("up")
      s.mockInput.pressArrow("up")
      await until(s, (f) => f.includes("❯ [ ] Include hidden"))
      s.mockInput.pressKey(" ")
      await until(s, (f) => f.includes("[x] Include hidden"))
      s.mockInput.pressKey("s")
      await until(s, (f) => f.includes("Index ready"))
      expect(t.calls.saved).toHaveLength(1)
      expect(t.calls.saved[0]!.includeHidden).toBe(true)
      expect(t.calls.saved[0]!.roots).toEqual(["~/Documents", "~/Downloads"])
      expect(t.calls.indexRuns).toBe(1)
      await type(s, "budget")
      const frame = await until(s, (f) => f.includes("budget.xlsx") && f.includes("report.docx") && f.includes(" FIND ") && f.includes("exact text"))
      expect(frame).toMatch(/\d+ results?/)
      // Downloads is indexed too...
      await esc(s)
      await until(s, (f) => !f.includes("❯ budget"))
      await type(s, "zanzibar")
      await until(s, (f) => f.includes("unknown-text-file"))
      // ...but the rest of the home folder is not.
      await esc(s)
      await until(s, (f) => !f.includes("❯ zanzibar"))
      await type(s, "pancakes")
      await until(s, (f) => f.includes("No matches"))
      expect(exited).toBeUndefined()
    } finally {
      s.renderer.destroy()
      t.close()
    }
  })

  test("a setup error stays up until the next key", async () => {
    const t = testServices({ ...defaultConfig(), roots: [] }, { firstRun: true })
    const s = await testRender(() => <App services={t.services} />, { width: 120, height: 32 })
    try {
      await until(s, (f) => f.includes("Welcome to zsearch"))
      s.mockInput.pressKey("s")
      await until(s, (f) => f.includes("Enter at least one folder"))
      expect(t.calls.saved).toHaveLength(0)
      s.mockInput.pressArrow("up")
      await until(s, (f) => !f.includes("Enter at least one folder"))
    } finally {
      s.renderer.destroy()
      t.close()
    }
  })
})

describe("search screen", () => {
  let t: ReturnType<typeof testServices>
  let s: Setup
  let exited: string | null | undefined

  beforeAll(async () => {
    t = testServices(homeConfig())
    // Build the index up front so the app opens straight into search.
    await t.services.startIndex(homeConfig(), {}).done
    t.resetEngine()
    s = await testRender(() => <App services={t.services} onExit={(sel) => (exited = sel)} />, { width: 120, height: 32 })
    await until(s, (f) => f.includes("Start typing") || f.includes("results"))
  })

  afterAll(() => {
    s.renderer.destroy()
    t.close()
  })

  test("typing shows results with snippets and a preview", async () => {
    await type(s, "calvin")
    const f = await until(s, (f) => f.includes("paper.pdf") && f.includes("page 2"))
    expect(f).toContain("Calvin cycle")
    expect(f).toContain("p.2") // location label in the result list
    expect(f).toContain("PDF")
  })

  test("highlights are styled", async () => {
    const spans = s.captureSpans()
    const all = spans.lines.flatMap((l) => l.spans)
    const hit = all.find((sp) => sp.text.includes("Calvin") && sp.text.length <= 8)
    expect(hit).toBeDefined()
  })

  test("Enter opens the selected file; Ctrl-E edits at the matching line; Ctrl-Y copies", async () => {
    s.mockInput.pressEnter()
    await until(s, (f) => f.includes("Opened"))
    expect(t.calls.open[0]).toEndWith("Documents/paper.pdf")
    s.mockInput.pressKey("y", { ctrl: true })
    await until(s, (f) => f.includes("Copied"))
    expect(t.calls.copy[0]).toEndWith("Documents/paper.pdf")
    s.mockInput.pressKey("e", { ctrl: true })
    await Bun.sleep(50)
    expect(t.calls.edit[0]!.path).toEndWith("Documents/paper.pdf")
    expect(t.calls.edit[0]!.line).toBeUndefined() // documents open without a line number
  })

  test("arrow keys move the selection and update the preview", async () => {
    await esc(s)
    await type(s, "budget")
    const list = listed(await until(s, (f) => f.includes("report.docx") && f.includes("3 results")))
    expect(list.sort()).toEqual(["budget.xlsx", "deck.pptx", "report.docx"])
    const order = listed(s.captureCharFrame())
    s.mockInput.pressArrow("down")
    await until(s, (f) => f.includes(`~/Documents/${order[1]}`))
    s.mockInput.pressKey("e", { ctrl: true })
    await Bun.sleep(50)
    expect(t.calls.edit[t.calls.edit.length - 1]!.path).toEndWith(order[1]!)
  })

  test("mouse: click selects, wheel scrolls", async () => {
    await esc(s)
    await type(s, "budget")
    const order = listed(await until(s, (f) => f.includes("report.docx") && f.includes("3 results")))
    // Rows: 3 (search box) + 1 (mode bar); the first result occupies rows 4-5, the second rows 6-7.
    await s.mockMouse.click(10, 6)
    await until(s, (f) => f.includes(`~/Documents/${order[1]}`))
    await s.mockMouse.scroll(10, 6, "down")
    await until(s, (f) => f.includes(`~/Documents/${order[2]}`))
  })

  test("Tab switches between find, fuzzy and semantic", async () => {
    s.mockInput.pressTab()
    await until(s, (f) => f.includes(" FUZZY ") && f.includes("fuzzy names"))
    s.mockInput.pressTab()
    // Without the model: word matches, and a notice saying how to turn semantic search on.
    await until(s, (f) => f.includes(" SEMANTIC ") && f.includes("Semantic search is off"))
    s.mockInput.pressTab()
    await until(s, (f) => f.includes(" FIND ") && f.includes("exact text (indexed)"))
  })

  test("filters and regex from the query box", async () => {
    await esc(s)
    await type(s, "/MAX_\\w+/")
    const f = await until(s, (f) => f.includes("MAX_RETRIES = 42"))
    expect(f).toContain("parse_config.py")
    expect(f).toContain("regex (indexed)")
    expect(f).toContain(" FIND ")
    await esc(s)
    await type(s, "type:slides")
    const g = await until(s, (f) => f.includes("deck.pptx") && f.includes("slides.odp") && f.includes("recent files matching filters"))
    expect(g).not.toContain("report.docx")
  })

  test("Ctrl-F / Ctrl-B jump between matches in the preview; Alt-digits pick a mode", async () => {
    corpus.write("notes/long.txt", Array.from({ length: 120 }, (_, i) => (i % 40 === 5 ? `line ${i} mentions zebra` : `filler line ${i}`)).join("\n"))
    s.mockInput.pressKey("r", { ctrl: true })
    await until(s, (f) => f.includes("Index ready") && f.includes("1 new"))
    await esc(s)
    await type(s, "zebra")
    await until(s, (f) => f.includes("long.txt") && f.includes("▶ line 5 mentions zebra"))
    s.mockInput.pressKey("f", { ctrl: true })
    await until(s, (f) => f.includes("▶ line 45 mentions zebra"))
    s.mockInput.pressKey("f", { ctrl: true })
    await until(s, (f) => f.includes("▶ line 85 mentions zebra"))
    s.mockInput.pressKey("b", { ctrl: true })
    await until(s, (f) => f.includes("▶ line 45 mentions zebra"))
    s.mockInput.pressKey("2", { meta: true })
    await until(s, (f) => f.includes(" FUZZY "))
    s.mockInput.pressKey("3", { meta: true })
    await until(s, (f) => f.includes(" SEMANTIC "))
    s.mockInput.pressKey("1", { meta: true })
    await until(s, (f) => f.includes(" FIND "))
  })

  test("help overlay", async () => {
    s.mockInput.pressKey("F1")
    const f = await until(s, (f) => f.includes("zsearch help"))
    expect(f).toContain("Query syntax")
    await esc(s)
    await until(s, (f) => !f.includes("zsearch help"))
  })

  test("no results message suggests the other mode", async () => {
    await esc(s)
    await type(s, "qqqzzzxxx")
    await until(s, (f) => f.includes("No matches") && f.includes("Tab for fuzzy search"))
    s.mockInput.pressTab()
    await until(s, (f) => f.includes("No matches") && f.includes("Tab to semantic search"))
    s.mockInput.pressTab()
    await until(s, (f) => f.includes("No matches") && f.includes("Tab to find the exact text"))
    s.mockInput.pressTab()
    await until(s, (f) => f.includes(" FIND "))
  })

  test("Ctrl-T toggles the preview; narrow terminals hide it", async () => {
    await esc(s)
    await type(s, "pancakes")
    await until(s, (f) => f.includes("~/notes/recipes/pancakes.txt"))
    s.mockInput.pressKey("t", { ctrl: true })
    await until(s, (f) => !f.includes("~/notes/recipes/pancakes.txt"))
    s.mockInput.pressKey("t", { ctrl: true })
    await until(s, (f) => f.includes("~/notes/recipes/pancakes.txt"))
    s.resize(80, 24)
    await until(s, (f) => !f.includes("~/notes/recipes/pancakes.txt") && f.includes("pancakes.txt"))
    s.resize(120, 32)
  })

  test("Ctrl-R re-indexes and picks up new files", async () => {
    corpus.write("notes/brand-new.txt", "a note about narwhals")
    await esc(s)
    s.mockInput.pressKey("r", { ctrl: true })
    await until(s, (f) => f.includes("Index ready") && f.includes("1 new"))
    await type(s, "narwhals")
    await until(s, (f) => f.includes("brand-new.txt"))
  })

  test("settings overlay", async () => {
    s.mockInput.pressKey("s", { ctrl: true })
    const f = await until(s, (f) => f.includes("zsearch settings"))
    expect(f).toContain("Search inside files")
    expect(f).not.toContain("Semantic")
    await esc(s)
    await until(s, (f) => !f.includes("zsearch settings"))
  })

  test("Esc clears, then quits", async () => {
    await esc(s)
    await until(s, (f) => !f.includes("❯ narwhals"))
    await esc(s)
    for (let i = 0; i < 40 && exited === undefined; i++) await Bun.sleep(25)
    expect(exited).toBeNull()
  })
})

describe("print mode", () => {
  test("Enter returns the path instead of opening it", async () => {
    const t = testServices(homeConfig())
    let exited: string | null | undefined
    const s = await testRender(() => <App services={t.services} initialQuery="pancakes" printMode onExit={(sel) => (exited = sel)} />, { width: 100, height: 30 })
    try {
      await until(s, (f) => f.includes("pancakes.txt"))
      expect(s.captureCharFrame()).toContain("select")
      s.mockInput.pressEnter()
      for (let i = 0; i < 40 && exited === undefined; i++) await Bun.sleep(25)
      expect(exited).toEndWith("notes/recipes/pancakes.txt")
      expect(t.calls.open).toHaveLength(0)
    } finally {
      s.renderer.destroy()
      t.close()
    }
  })
})

describe("another process indexing", () => {
  test("Ctrl-R waits for its refresh of changed files, but not for a full update", async () => {
    const t = testServices(homeConfig())
    await t.services.startIndex(homeConfig(), {}).done
    t.resetEngine()
    let partial = true
    t.services.indexLockedBy = () => 999_999
    t.services.partialRunHolds = () => partial
    const s = await testRender(() => <App services={t.services} onExit={() => {}} />, { width: 120, height: 32 })
    try {
      await until(s, (f) => f.includes("Start typing") || f.includes("results"))
      const before = t.calls.indexRuns
      s.mockInput.pressKey("r", { ctrl: true })
      await until(s, (f) => f.includes("Index ready"))
      expect(t.calls.indexRuns).toBe(before + 1)
      partial = false
      s.mockInput.pressKey("r", { ctrl: true })
      await until(s, (f) => f.includes("Another zsearch process (pid 999999)"))
      expect(t.calls.indexRuns).toBe(before + 1)
    } finally {
      s.renderer.destroy()
      t.close()
    }
  })
})
describe("terminal editor", () => {
  test.skipIf(!Bun.which("script"))("gets the terminal when stdout is piped (print mode)", async () => {
    const bin = join(corpus.home, "fake-bin")
    const marker = join(corpus.home, "editor-saw")
    mkdirSync(bin, { recursive: true })
    // Named like a terminal editor; records whether it was given the terminal.
    writeFileSync(join(bin, "nano"), `#!/bin/sh\nif [ -t 0 ] && [ -t 1 ]; then saw=tty; else saw=pipe; fi\necho "$saw" > "${marker}"\n`, { mode: 0o755 })
    const child = join(corpus.home, "edit-child.ts")
    writeFileSync(child, `
      const { realServices } = await import(${JSON.stringify(join(import.meta.dir, "../src/tui/services.ts"))})
      const { defaultConfig } = await import(${JSON.stringify(join(import.meta.dir, "../src/config.ts"))})
      const s = realServices({ ...defaultConfig(), roots: [] })
      const err = await s.edit(${JSON.stringify(child)}, undefined, async () => {}, async () => {})
      s.search.close(); await s.dispose()
      if (err) console.error(err)
      process.exit(0)
    `)
    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(child)} | cat >/dev/null`
    const args = process.platform === "darwin" ? ["script", "-q", "/dev/null", "sh", "-c", cmd] : ["script", "-qec", cmd, "/dev/null"]
    const p = Bun.spawn(args, { env: { ...process.env, EDITOR: join(bin, "nano"), VISUAL: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => p.kill(), 20_000)
    await p.exited
    clearTimeout(timer)
    expect(readFileSync(marker, "utf8").trim()).toBe("tty")
  }, 30_000)
})

describe("quitting", () => {
  test("waits for the index run it started to stop", async () => {
    // Index workers see the real HOME, not the one these tests set: name the folder outright.
    const config = { ...defaultConfig(), roots: [corpus.home] }
    const services = realServices(config)
    let stopped = false
    const run = services.startIndex(config, {})
    void run.done.then(() => { stopped = true })
    services.search.close()
    await services.dispose!()
    expect(stopped).toBe(true)
    expect(lockHolder(services.paths.lock)).toBeNull()
  })
})
