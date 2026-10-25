import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type Config, configKeys, defaultConfig, saveConfig } from "../src/config.ts"
import { checkArgs } from "../src/mcp/rpc.ts"
import { CONFIG_KEYS, withSetting } from "../src/mcp/server.ts"
import { jsonLines } from "./helpers/json-lines.ts"

type Msg = Record<string, any>

const MAIN = join(import.meta.dir, "..", "src", "main.ts")
let home: string

const write = (rel: string, data: string) => {
  const p = join(home, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, data)
  return p
}

function saveLocal(config: Config) {
  const previous = process.env.ZSEARCH_HOME
  process.env.ZSEARCH_HOME = join(home, ".zsearch-mcp")
  saveConfig(config)
  if (previous === undefined) delete process.env.ZSEARCH_HOME
  else process.env.ZSEARCH_HOME = previous
}

const clients = new Set<ReturnType<typeof jsonLines>>()
afterEach(async () => {
  for (const client of clients) await client.dispose()
  clients.clear()
})

/** Start `zsearch mcp` on the test home and talk JSON-RPC to it. */
async function client() {
  const proc = Bun.spawn(["bun", MAIN, "mcp"], {
    cwd: home,
    env: { ...process.env, HOME: home, ZSEARCH_HOME: join(home, ".zsearch-mcp") },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const transport = jsonLines(proc)
  clients.add(transport)
  const { request } = transport
  const schemas = new Map<string, Msg>()
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await request("tools/call", { name, arguments: args })
    if (r.error) throw new Error(r.error.message)
    const result = r.result as { content: { text: string }[]; structuredContent?: Msg; isError?: boolean }
    if (!result.isError) expect(checkArgs(schemas.get(name)!.outputSchema, result.structuredContent).errors).toEqual([])
    return { text: result.content[0]!.text, data: result.structuredContent as Msg, isError: result.isError === true }
  }
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } })
  for (const t of (await request("tools/list")).result.tools) schemas.set(t.name, t)
  return { call, close: transport.close }
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "zsearch-review-mcp-"))
  saveLocal({ ...defaultConfig(), roots: ["~"] })
  // Files whose contents cannot be read: corrupt documents.
  write("secret/confidential-merger.docx", "not a zip file at all")
  write("public/broken-report.docx", "not a zip file either")
  for (let i = 0; i < 1005; i++) write(`pool/pagetoken-${String(i).padStart(4, "0")}.txt`, "")
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

test("only the documented preferences can be changed remotely", () => {
  expect([...CONFIG_KEYS].sort()).toEqual(["autoRefreshMinutes", "defaultMode", "indexLoad", "pauseOnBattery", "pauseOnLowPower", "preview", "semantic.code", "semantic.declined", "semantic.enabled", "workers"])
  const c = defaultConfig()
  expect(() => withSetting(c, "skipDatasetOcr", "false")).toThrow("must be changed in the app")
  for (const key of configKeys().filter((k) => !CONFIG_KEYS.includes(k))) expect(() => withSetting(c, key, "true")).toThrow("must be changed in the app")
})

test("mcp: diagnostics follow current exclusions, and every advertised page can be fetched", async () => {
  const c = await client()
  try {
    expect((await c.call("set_config", { key: "skipDatasetOcr", value: "false" })).isError).toBe(true)
    const update = await c.call("update_index", { wait_seconds: 60 })
    expect(update.data.status, JSON.stringify(update)).toBe("done")

    const before = (await c.call("index_status", { errors: true })).data.unreadableFiles.map((f: Msg) => f.path)
    expect(before).toContain(join(home, "secret/confidential-merger.docx"))
    expect(before).toContain(join(home, "public/broken-report.docx"))
    const status = await c.call("index_status", { errors: true })
    expect(status.data.unreadableFiles.find((f: Msg) => f.path === join(home, "public/broken-report.docx"))).toMatchObject({ category: "unreadable", retry: true })
    expect(status.data.problems.find((p: Msg) => p.category === "unreadable").count).toBeGreaterThanOrEqual(2)
    expect(status.text).toContain("could not be read")

    // Excluded locally, without updating the index: the stored row stays, but is not shown or counted.
    saveLocal({ ...defaultConfig(), roots: ["~"], exclude: ["~/secret"] })
    expect((await c.call("search", { query: "confidential-merger" })).data.hits).toEqual([])
    const after = await c.call("index_status", { errors: true })
    expect(after.data.unreadableFiles.map((f: Msg) => f.path)).toEqual([join(home, "public/broken-report.docx")])
    expect(after.text).not.toContain("confidential")
    expect(after.data.problems.find((p: Msg) => p.category === "unreadable").count).toBe(1)
    // Ignore rules too.
    write("public/.zsearchignore", "broken-*\n")
    expect((await c.call("index_status", { errors: true })).data.unreadableFiles).toEqual([])
    expect((await c.call("index_status", { errors: true, errors_limit: 1 })).data.unreadableFiles).toEqual([])
    const ignored = await c.call("index_status")
    expect(ignored.data.problems.find((p: Msg) => p.category === "unreadable")).toBeUndefined()

    // Pages up to the end of the result pool are accepted when advertised.
    const page = await c.call("search", { query: "pagetoken", limit: 20, offset: 800 })
    expect(page.data.hits).toHaveLength(20)
    expect(page.text).toContain("call again with offset 820")
    const next = await c.call("search", { query: "pagetoken", limit: 20, offset: 820 })
    expect(next.isError).toBe(false)
    expect(next.data.hits).toHaveLength(20)
    const last = await c.call("search", { query: "pagetoken", limit: 20, offset: 980 })
    expect(last.isError).toBe(false)
    expect(last.data.hits).toHaveLength(20)
    // The pool ends at 1000 results: no offset past it is advertised.
    expect(last.text).not.toContain("call again with offset")
    expect((await c.call("search", { query: "pagetoken", limit: 1, offset: 999 })).data.hits).toHaveLength(1)
    expect((await c.call("search", { query: "pagetoken", offset: 1000 })).isError).toBe(true)

    // Semantic settings take effect at the next index run.
    const code = await c.call("set_config", { key: "semantic.code", value: "true" })
    expect(code.data.reindexNeeded).toBe(true)
    expect(code.text).toContain("Call update_index")
  } finally {
    await c.close()
  }
}, 120_000)
