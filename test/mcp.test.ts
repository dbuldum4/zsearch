import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig } from "../src/config.ts"
import { checkArgs, McpServer, type Tool, ToolError } from "../src/mcp/rpc.ts"
import { buildQuery, CONFIG_KEYS, withSetting } from "../src/mcp/server.ts"
import { clearIndex, openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { readIndexed } from "../src/search/read.ts"
import { homeConfig, makeCorpus } from "./helpers/corpus.ts"

type Msg = Record<string, any>

/* ------------------------------------------------------------- protocol -- */

describe("MCP protocol", () => {
  const echo: Tool = {
    name: "echo",
    title: "Echo",
    description: "Echo the text back",
    inputSchema: { type: "object", properties: { text: { type: "string" }, times: { type: "integer", minimum: 1, maximum: 3, default: 1 } }, required: ["text"], additionalProperties: false },
    outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async run(args, ctx) {
      if (args.text === "fail") throw new ToolError("asked to fail")
      if (args.text === "wait") {
        ctx.progress(1, 2, "halfway")
        await new Promise((r) => ctx.signal.addEventListener("abort", r))
      }
      const text = String(args.text).repeat(args.times as number)
      return { text, structured: { text } }
    },
  }

  function server() {
    const out: Msg[] = []
    const s = new McpServer({ name: "t", title: "Test", version: "1.0.0", instructions: "be nice" }, { tools: [echo] }, (line) => out.push(JSON.parse(line)))
    const req = async (method: string, params?: unknown, id: number | string = 1) => {
      await s.receive(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }))
      return out.at(-1)!
    }
    return { s, out, req }
  }

  test("initialize negotiates the version and lists capabilities", async () => {
    const { req } = server()
    const r = (await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } })).result
    expect(r.protocolVersion).toBe("2025-06-18")
    expect(r.serverInfo).toEqual({ name: "t", title: "Test", version: "1.0.0" })
    expect(r.instructions).toBe("be nice")
    expect(r.capabilities.tools).toBeDefined()
    expect(r.capabilities.prompts).toBeUndefined()
    // An unknown version is answered with the newest one.
    expect((await req("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-11-25")
  })

  test("older clients get no titles, output schemas or structured content", async () => {
    const { req } = server()
    await req("initialize", { protocolVersion: "2025-03-26" })
    const tool = (await req("tools/list")).result.tools[0]
    expect(tool.title).toBeUndefined()
    expect(tool.outputSchema).toBeUndefined()
    const r = (await req("tools/call", { name: "echo", arguments: { text: "a" } })).result
    expect(r).toEqual({ content: [{ type: "text", text: "a" }] })
  })

  test("tools: structured results, defaults, coercion and errors the model can read", async () => {
    const { req } = server()
    await req("initialize", { protocolVersion: "2025-06-18" })
    const list = (await req("tools/list")).result.tools
    expect(list[0]).toMatchObject({ name: "echo", title: "Echo", outputSchema: { type: "object" } })
    expect((await req("tools/call", { name: "echo", arguments: { text: "ab", times: "2" } })).result).toEqual({ content: [{ type: "text", text: "abab" }], structuredContent: { text: "abab" } })
    const bad = (await req("tools/call", { name: "echo", arguments: { times: 9, extra: true } })).result
    expect(bad.isError).toBe(true)
    expect(bad.content[0].text).toContain("missing required argument: text")
    expect(bad.content[0].text).toContain("times should be at most 3")
    expect(bad.content[0].text).toContain("unknown argument: extra")
    const failed = (await req("tools/call", { name: "echo", arguments: { text: "fail" } })).result
    expect(failed).toEqual({ content: [{ type: "text", text: "asked to fail" }], isError: true })
    expect((await req("tools/call", { name: "nope", arguments: {} })).error.code).toBe(-32602)
  })

  test("ping, unknown methods, bad JSON, batches and notifications", async () => {
    const { s, out, req } = server()
    expect(await req("ping")).toEqual({ jsonrpc: "2.0", id: 1, result: {} })
    expect((await req("bogus/method")).error.code).toBe(-32601)
    await s.receive("{not json")
    expect(out.at(-1)!.error.code).toBe(-32700)
    await s.receive(JSON.stringify([{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: "b", method: "ping" }]))
    expect(out.at(-1)).toEqual([
      { jsonrpc: "2.0", id: "a", result: {} },
      { jsonrpc: "2.0", id: "b", result: {} },
    ])
    const before = out.length
    await s.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))
    expect(out.length).toBe(before)
    expect((await req("logging/setLevel", { level: "loud" })).error.code).toBe(-32602)
    expect((await req("logging/setLevel", { level: "error" })).result).toEqual({})
    s.log("info", "hidden")
    s.log("error", "shown")
    expect(out.at(-1)).toEqual({ jsonrpc: "2.0", method: "notifications/message", params: { level: "error", logger: "t", data: "shown" } })
  })

  test("progress notifications, and cancelling a call leaves it unanswered", async () => {
    const { s, out } = server()
    await s.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }))
    const call = s.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo", arguments: { text: "wait" }, _meta: { progressToken: "tok" } } }))
    await Bun.sleep(10)
    expect(out.at(-1)).toEqual({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "tok", progress: 1, total: 2, message: "halfway" } })
    await s.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "changed my mind" } }))
    await call
    expect(out.some((m) => m.id === 7)).toBe(false)
  })

  test("argument checking", () => {
    const schema = { type: "object", properties: { tags: { type: "array", items: { type: "string" } }, on: { type: "boolean" }, n: { type: "number" }, v: { type: ["string", "number"] } }, additionalProperties: false }
    expect(checkArgs(schema, { tags: "a", on: "true", n: "1.5", v: 3 })).toEqual({ value: { tags: ["a"], on: true, n: 1.5, v: 3 }, errors: [] })
    expect(checkArgs({ type: "object", properties: { s: { type: "string" }, t: { type: "string" }, u: { type: "string" } } }, { s: 3, t: true, u: ["a", "b"] }).value).toEqual({ s: "3", t: "true", u: '["a","b"]' })
    expect(checkArgs(schema, { on: "maybe", n: "x", v: false }).errors).toEqual(["on should be boolean, not string", "n should be number, not string", "v should be string or number, not boolean"])
  })
})

/* -------------------------------------------------------------- helpers -- */

describe("MCP tool helpers", () => {
  test("search arguments become zsearch query syntax", () => {
    expect(buildQuery({ query: "budget", type: ["sheet", "pdf"], ext: [".xlsx"], folder: ["~/My Docs"], modified: "<30d", size: ">1mb" })).toBe('budget type:sheet,pdf ext:xlsx in:"~/My Docs" size:>1mb mtime:<30d')
    expect(buildQuery({ query: "/\\d{4}/", regex: true, exclude_type: ["image"], after: "2024-01-01", before: "2024-06" })).toBe("re:\\d{4} -type:image after:2024-01-01 before:2024-06")
    expect(buildQuery({ query: "", path: "2024" })).toBe("path:2024")
    expect(() => buildQuery({ type: ["spaceship"] })).toThrow('unknown type "spaceship"')
    expect(() => buildQuery({ modified: "last week" })).toThrow("cannot contain spaces")
  })

  test("settings are converted to their type and checked", () => {
    const c = defaultConfig()
    expect(CONFIG_KEYS).toContain("content.maxTextMB")
    expect(CONFIG_KEYS).not.toContain("content")
    expect(withSetting(c, "includeHidden", "yes").includeHidden).toBe(true)
    expect(withSetting(c, "content.maxTextMB", 4).content.maxTextMB).toBe(4)
    expect(withSetting(c, "roots", "~/a, ~/b").roots).toEqual(["~/a", "~/b"])
    expect(withSetting(c, "exclude", ["*.log"]).exclude).toEqual(["*.log"])
    expect(withSetting(c, "roots", '["~/My, Folder", "~/b"]').roots).toEqual(["~/My, Folder", "~/b"])
    expect(() => withSetting(c, "roots", "[oops")).toThrow("expects a list of strings")
    expect(c.includeHidden).toBe(false)
    expect(() => withSetting(c, "indexLoad", 150)).toThrow("indexLoad must be a whole number from 10 to 100")
    expect(() => withSetting(c, "defaultMode", "regex")).toThrow('must be "find" or "fuzzy"')
    expect(() => withSetting(c, "includeHidden", 3)).toThrow("expects true or false")
    expect(() => withSetting(c, "nope", 1)).toThrow('unknown setting "nope"')
  })
})

/* ------------------------------------------------------------- reading -- */

test("read_file finds the file when it reads it, so a rebuilt index cannot swap in another", async () => {
  const home = mkdtempSync(join(tmpdir(), "zsearch-read-"))
  // The index lives outside home, so home holds one file each time and the rebuild reuses its id.
  const dbDir = mkdtempSync(join(tmpdir(), "zsearch-read-db-"))
  const prevHome = process.env.HOME
  process.env.HOME = home
  try {
    writeFileSync(join(home, "old.txt"), "the old file\n")
    const db = openDb(join(dbDir, "index.db"))
    const config = homeConfig()
    await new Indexer(db, config, { inProcess: true }).run()
    const engine = new SearchEngine(db, config)
    const opts = { lines: 10, maxChars: 1000 }
    const before = readIndexed(engine, join(home, "old.txt"), "", "find", opts)!
    expect(before.lines[0]!.text).toBe("the old file")
    // A rebuild hands the old file's id to a new one.
    rmSync(join(home, "old.txt"))
    writeFileSync(join(home, "new.txt"), "an unrelated new file\n")
    clearIndex(db)
    await new Indexer(db, config, { inProcess: true }).run()
    const after = readIndexed(engine, join(home, "new.txt"), "", "find", opts)!
    expect(after.id).toBe(before.id)
    expect(after.lines[0]!.text).toBe("an unrelated new file")
    expect(readIndexed(engine, join(home, "old.txt"), "", "find", opts)).toBeNull()
    db.close()
  } finally {
    process.env.HOME = prevHome
    rmSync(home, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------- end to end -- */

let corpus: ReturnType<typeof makeCorpus>
const MAIN = join(import.meta.dir, "..", "src", "main.ts")

beforeAll(() => {
  corpus = makeCorpus()
})
afterAll(() => corpus.cleanup())

/** Start `zsearch mcp` and talk JSON-RPC to it. */
function client() {
  const proc = Bun.spawn(["bun", MAIN, "mcp"], {
    cwd: corpus.home,
    env: { ...process.env, HOME: corpus.home, ZSEARCH_HOME: join(corpus.home, ".zsearch-mcp") },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const waiting = new Map<number, (m: Msg) => void>()
  const notes: Msg[] = []
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const m = JSON.parse(buffer.slice(0, nl)) as Msg
        buffer = buffer.slice(nl + 1)
        if (typeof m.id === "number" && waiting.has(m.id)) {
          waiting.get(m.id)!(m)
          waiting.delete(m.id)
        } else notes.push(m)
      }
    }
  })()
  let nextId = 0
  const request = (method: string, params: unknown = {}): Promise<Msg> => {
    const id = ++nextId
    const reply = new Promise<Msg>((r) => waiting.set(id, r))
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    proc.stdin.flush()
    return reply
  }
  const tools = new Map<string, Msg>()
  /** Call a tool; check its structured result against its output schema. */
  const call = async (name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) => {
    const r = await request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) })
    if (r.error) throw new Error(r.error.message)
    const result = r.result as { content: { text: string }[]; structuredContent?: Msg; isError?: boolean }
    const schema = tools.get(name)?.outputSchema
    if (!result.isError && schema) {
      expect(result.structuredContent).toBeDefined()
      expect(checkArgs(schema, result.structuredContent).errors).toEqual([])
    }
    return { text: result.content[0]!.text, data: result.structuredContent as Msg, isError: result.isError === true }
  }
  const start = async () => {
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } })
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
    for (const t of (await request("tools/list")).result.tools) tools.set(t.name, t)
    return init.result
  }
  return { proc, request, call, start, notes, tools }
}

test("mcp: index, search, read and configure over stdio", async () => {
  const c = client()
  const init = await c.start()
  expect(init.serverInfo.name).toBe("zsearch")
  expect(init.instructions).toContain("search")
  expect([...c.tools.keys()]).toEqual(["search", "read_file", "index_status", "update_index", "cancel_index", "get_config", "set_config"])
  for (const t of c.tools.values()) {
    expect(t.inputSchema.type).toBe("object")
    expect(t.description.length).toBeGreaterThan(40)
    expect(t.annotations).toBeDefined()
  }

  // Nothing indexed yet: the search says what to do.
  const empty = await c.call("search", { query: "pancakes" })
  expect(empty.data.hits).toEqual([])
  expect(empty.text).toContain("update_index")
  expect((await c.call("index_status")).data.lastIndexedAt).toBeNull()

  // Files for paging and long reads: match counts that run against modification order, a line
  // longer than one read returns, a big folder, and more matching lines than one read returns.
  for (let i = 1; i <= 10; i++) {
    const p = corpus.write(`paging/zebrafish-${i}.txt`, "zebrafish ".repeat(i))
    utimesSync(p, new Date(2020, 0, 20 - i), new Date(2020, 0, 20 - i))
  }
  corpus.write("long/one-line.txt", "a".repeat(2_500) + "TAIL\n" + "b".repeat(150_000) + "END\nlast line\n")
  for (let i = 1; i <= 600; i++) corpus.write(`many/entry-${String(i).padStart(3, "0")}.txt`, "")
  corpus.write("long/matches.txt", Array.from({ length: 3000 }, (_, i) => `match me ${i + 1}`).join("\n") + "\n")

  // Index the whole (test) home folder, waiting for it, with progress notifications.
  const indexed = await c.call("update_index", { roots: ["~"], wait_seconds: 60 }, { progressToken: "idx" })
  expect(indexed.data.status).toBe("done")
  expect(indexed.data.roots).toEqual(["~"])
  expect(indexed.data.files).toBeGreaterThan(10)
  const progress = c.notes.filter((m) => m.method === "notifications/progress")
  expect(progress.length).toBeGreaterThan(0)
  expect(progress.every((m) => m.params.progressToken === "idx")).toBe(true)
  const values = progress.map((m) => m.params.progress as number)
  expect(values).toEqual([...values].sort((a, b) => a - b))
  expect(c.notes.some((m) => m.method === "notifications/message" && String(m.params.data).startsWith("Index updated"))).toBe(true)

  // Several searches at once all get their own answers.
  const [pancakes, passport, budget] = await Promise.all([c.call("search", { query: "pancakes" }), c.call("search", { query: "renew passport" }), c.call("search", { query: "budget", type: ["sheet"] })])
  expect(pancakes.data.hits.map((h: Msg) => h.path)).toContain(join(corpus.home, "notes/recipes/pancakes.txt"))
  expect(passport.data.hits[0].path).toBe(join(corpus.home, "notes/todo.md"))
  expect(passport.data.hits[0].lines[0]).toMatchObject({ line: 3, text: expect.stringContaining("renew passport") })
  expect(passport.text).toContain("line 3: - renew passport before the trip to Lisbon")
  expect(budget.data.query).toBe("budget type:sheet")
  expect(budget.data.hits.length).toBeGreaterThan(0)
  expect(budget.data.hits.every((h: Msg) => h.kind === "sheet")).toBe(true)

  // Regex, fuzzy, folder and date filters, paging.
  const re = await c.call("search", { query: "MAX_RETRIES = \\d+", regex: true })
  expect(re.data.hits[0].path).toEndWith("parse_config.py")
  const fuzzy = await c.call("search", { query: "parsconfig", mode: "fuzzy" })
  expect(fuzzy.data.hits[0].path).toEndWith("parse_config.py")
  const inNotes = await c.call("search", { folder: ["notes"], modified: ">1y" })
  expect(inNotes.data.hits.map((h: Msg) => h.path)).toEqual([join(corpus.home, "notes/journal-2024.md")])
  const page1 = await c.call("search", { query: "", limit: 2 })
  const page2 = await c.call("search", { query: "", limit: 2, offset: 2 })
  expect(page1.data.hits.length).toBe(2)
  expect(page2.data.offset).toBe(2)
  expect(page2.data.hits[0].path).not.toBe(page1.data.hits[0].path)
  expect((await c.call("search", { query: "x", type: ["spaceship"] })).isError).toBe(true)
  expect((await c.call("search", { limit: 0 })).text).toContain("limit should be at least 1")

  // Reading files: around a match, a range, matching lines only, paged documents.
  const pdf = join(corpus.home, "Documents/paper.pdf")
  const read = await c.call("read_file", { path: pdf, query: "Calvin" })
  expect(read.data.pages).toBe(2)
  expect(read.data.matchLines.length).toBe(1)
  const hitLine = read.data.lines.find((l: Msg) => l.match)
  expect(hitLine).toMatchObject({ page: 2, text: expect.stringContaining("Calvin cycle") })
  expect(read.text).toContain("--- page 2 ---")
  const todo = await c.call("read_file", { path: "~/notes/todo.md", line: 3, lines: 1 })
  expect(todo.data.lines).toEqual([{ line: 3, text: "- renew passport before the trip to Lisbon" }])
  expect(todo.data.more).toBe(true)
  expect(todo.text).toContain("call again with line 4")
  const only = await c.call("read_file", { path: "~/code/app/src/server.ts", query: "PORT", matches_only: true, context: 0 })
  expect(only.data.lines.map((l: Msg) => l.line)).toEqual([7, 8])
  expect(only.data.lines.every((l: Msg) => l.match)).toBe(true)
  const missing = await c.call("read_file", { path: "~/code/app/dist/bundle.js" })
  expect(missing.isError).toBe(true)
  expect(missing.text).toContain("not in the index")
  expect((await c.call("read_file", { path: "~/notes/todo.md", matches_only: true })).isError).toBe(true)

  // Pages of a search never overlap or skip, however the ranking pools change with the limit.
  const paged: string[] = []
  for (let offset = 0; offset < 10; offset += 2) paged.push(...(await c.call("search", { query: "zebrafish", limit: 2, offset })).data.hits.map((h: Msg) => h.path))
  expect(new Set(paged).size).toBe(10)
  expect(paged.every((p) => p.includes("/paging/zebrafish-"))).toBe(true)

  // Long lines come back whole, or cut with a column to continue from.
  const long = join(corpus.home, "long/one-line.txt")
  const first = await c.call("read_file", { path: long, lines: 1 })
  expect(first.data.lines[0].text).toBe("a".repeat(2_500) + "TAIL")
  expect(first.data.next).toEqual({ line: 2, column: 1 })
  const huge = await c.call("read_file", { path: long, line: 2 })
  expect(huge.data.lines).toHaveLength(1)
  expect(huge.data.lines[0].cut).toBe(true)
  expect(huge.data.next.line).toBe(2)
  expect(huge.text).toContain(`call again with line 2 and column ${huge.data.next.column}`)
  const rest = await c.call("read_file", { path: long, line: 2, column: huge.data.next.column })
  expect(huge.data.lines[0].text + rest.data.lines[0].text).toBe("b".repeat(150_000) + "END")
  expect(rest.data.lines[0].column).toBe(huge.data.next.column)
  expect(rest.data.lines.map((l: Msg) => l.text)).toContain("last line")
  expect(rest.data.next).toBeNull()

  // Folders read by range.
  const folder = await c.call("read_file", { path: "~/many", line: 501, lines: 2 })
  expect(folder.data.totalLines).toBe(600)
  expect(folder.data.lines.map((l: Msg) => [l.line, l.text])).toEqual([
    [501, "entry-501.txt"],
    [502, "entry-502.txt"],
  ])
  expect(folder.data.next).toEqual({ line: 503, column: 1 })

  // Matching lines read on past what one call returns.
  const matches = join(corpus.home, "long/matches.txt")
  const m1 = await c.call("read_file", { path: matches, query: "match me", matches_only: true, context: 0, lines: 2000 })
  expect(m1.data.matchCount).toBe(3000)
  expect(m1.data.lines).toHaveLength(2000)
  expect(m1.data.next).toEqual({ line: 2001, column: 1 })
  const m2 = await c.call("read_file", { path: matches, query: "match me", matches_only: true, context: 0, lines: 2000, line: 2001 })
  expect(m2.data.lines.map((l: Msg) => l.line)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 2001))
  expect(m2.data.next).toBeNull()
  expect((await c.call("read_file", { path: matches, query: "/match (/", regex: true })).text).toContain("invalid regex")

  // Status and settings.
  const status = await c.call("index_status", { errors: true })
  expect(status.data.indexing).toBeNull()
  expect(status.data.lastRun.status).toBe("done")
  expect(Array.isArray(status.data.unreadableFiles)).toBe(true)
  expect(status.text).toContain("Folders: ~")
  const set = await c.call("set_config", { key: "exclude", value: ["*.md"] })
  expect(set.data).toEqual({ key: "exclude", value: ["*.md"], previous: [], reindexNeeded: true })
  expect(set.text).toContain("update_index")
  expect((await c.call("get_config", { key: "exclude" })).data.value).toEqual(["*.md"])
  expect((await c.call("get_config")).data.config.roots).toEqual(["~"])
  expect((await c.call("set_config", { key: "indexLoad", value: 5 })).isError).toBe(true)
  expect((await c.call("set_config", { key: "autoRefreshMinutes", value: "0" })).data.value).toBe(0)
  expect((await c.call("set_config", { key: "includeHidden", value: false })).data.value).toBe(false)
  // The excluded files leave the index at the next update.
  expect((await c.call("update_index", { wait_seconds: 60 })).data.status).toBe("done")
  expect((await c.call("search", { query: "renew passport" })).data.hits).toEqual([])
  expect((await c.call("cancel_index")).data.stopped).toBe(false)

  // Resources, prompts and completion.
  const resources = (await c.request("resources/list")).result.resources.map((r: Msg) => r.uri)
  expect(resources).toEqual(["zsearch://status", "zsearch://config", "zsearch://query-syntax"])
  expect(JSON.parse((await c.request("resources/read", { uri: "zsearch://status" })).result.contents[0].text).files).toBeGreaterThan(5)
  expect((await c.request("resources/templates/list")).result.resourceTemplates[0].uriTemplate).toBe("file://{+path}")
  const file = (await c.request("resources/read", { uri: `file://${pdf}` })).result.contents[0]
  expect(file.text).toContain("[page 2]")
  expect(file.text).toContain("Calvin cycle")
  expect((await c.request("resources/read", { uri: "file:///nowhere/at/all.txt" })).error.code).toBe(-32002)
  const prompts = (await c.request("prompts/list")).result.prompts.map((p: Msg) => p.name)
  expect(prompts).toEqual(["find_files", "summarize_file"])
  const summary = (await c.request("prompts/get", { name: "summarize_file", arguments: { path: pdf } })).result
  expect(summary.messages[0].content.resource.text).toContain("Photosynthesis")
  expect((await c.request("prompts/get", { name: "find_files", arguments: {} })).error.code).toBe(-32602)
  const completion = (await c.request("completion/complete", { ref: { type: "ref/prompt", name: "summarize_file" }, argument: { name: "path", value: "pancakes" } })).result.completion
  expect(completion.values).toContain(join(corpus.home, "notes/recipes/pancakes.txt"))

  // Closing stdin ends the server.
  c.proc.stdin.end()
  expect(await c.proc.exited).toBe(0)
  expect(await new Response(c.proc.stderr).text()).not.toContain("Error")
}, 120_000)
