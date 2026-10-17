import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { clearIndex, getMeta, openDb, setMeta } from "../src/index/db.ts"
import { width, wrapLine } from "../src/tui/styled.ts"
import { makeCorpus } from "./helpers/corpus.ts"

const MAIN = join(import.meta.dir, "..", "src", "main.ts")
let corpus: ReturnType<typeof makeCorpus>

beforeAll(() => {
  corpus = makeCorpus()
})
afterAll(() => corpus.cleanup())

function env(): Record<string, string | undefined> {
  return { ...process.env, HOME: corpus.home, ZSEARCH_HOME: join(corpus.home, ".zsearch-data"), NO_COLOR: "1" }
}

async function zs(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", MAIN, ...args], { cwd: corpus.home, env: env(), stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out, err }
}

describe("index --rebuild", () => {
  test("keeps the database open elsewhere working", async () => {
    expect((await zs("index", "--home", "-q")).code).toBe(0)
    const db = new Database(join(corpus.home, ".zsearch-data", "index.db"))
    try {
      const count = () => (db.query("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n
      const before = count()
      expect(before).toBeGreaterThan(0)
      const r = await zs("index", "--rebuild", "-q")
      expect(r.code).toBe(0)
      expect(count()).toBe(before)
      expect((await zs("search", "pancakes")).out).toContain("pancakes")
    } finally {
      db.close()
    }
  }, 60000)

  test("starts over from a file that is no database", async () => {
    writeFileSync(join(corpus.home, ".zsearch-data", "index.db"), "not an SQLite database, ".repeat(64))
    const r = await zs("index", "--rebuild", "-q")
    expect({ code: r.code, err: r.code ? r.err : "" }).toEqual({ code: 0, err: "" })
    expect((await zs("search", "pancakes")).out).toContain("pancakes")
  }, 60000)

  test("an emptied index does not look up to date", () => {
    const db = openDb(":memory:")
    try {
      setMeta(db, "last_indexed_at", "123")
      setMeta(db, "last_duration_ms", "4")
      clearIndex(db)
      expect(getMeta(db, "last_indexed_at")).toBeNull()
      expect(getMeta(db, "last_duration_ms")).toBeNull()
    } finally {
      db.close()
    }
  })
})

describe("semantic install", () => {
  test("keeps settings changed while the model downloads", async () => {
    const data = join(corpus.home, ".zsearch-sem")
    mkdirSync(data, { recursive: true })
    const configFile = join(data, "config.json")
    writeFileSync(configFile, JSON.stringify({ roots: ["~/Documents"] }))
    const probe = join(data, "probe.ts")
    const model = join(import.meta.dir, "../src/semantic/model.ts")
    const config = join(import.meta.dir, "../src/config.ts")
    const cli = join(import.meta.dir, "../src/cli.ts")
    writeFileSync(probe, `import { mock } from "bun:test"
const real = await import(${JSON.stringify(model)})
const { loadConfig, saveConfig } = await import(${JSON.stringify(config)})
mock.module(${JSON.stringify(model)}, () => ({ ...real, downloadModels: async () => {
  const c = loadConfig()
  saveConfig({ ...c, roots: ["~/notes"], exclude: ["*.log"], content: { ...c.content, enabled: false }, semantic: { ...c.semantic, code: true } })
} }))
const { main } = await import(${JSON.stringify(cli)})
process.exit(await main(["semantic", "install"]))
`)
    const proc = Bun.spawn([process.execPath, probe], { env: { ...env(), ZSEARCH_HOME: data }, stdout: "pipe", stderr: "pipe" })
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect({ code, err: code ? err : "" }).toEqual({ code: 0, err: "" })
    const saved = JSON.parse(readFileSync(configFile, "utf8"))
    expect(saved.roots).toEqual(["~/notes"])
    expect(saved.exclude).toEqual(["*.log"])
    expect(saved.content.enabled).toBe(false)
    expect(saved.semantic).toEqual({ enabled: true, declined: false, code: true })
    expect(saved.defaultMode).toBe("semantic")
    rmSync(data, { recursive: true, force: true })
  }, 30000)
})

describe("wrapLine", () => {
  test("wraps by whole characters, keeping wide emoji", () => {
    const rows = wrapLine("abcdefg😀hi", [], 8)
    expect(rows.map((r) => r.text).join("")).toBe("abcdefg😀hi")
    for (const r of rows) expect(width(r.text)).toBeLessThanOrEqual(8)
    expect(rows.map((r) => r.text)).toEqual(["abcdefg", "😀hi"])
  })

  test("highlight ranges stay in UTF-16 offsets per row", () => {
    const text = "ab😀cd😀ef"
    const rows = wrapLine(text, [[2, 4]], 3)
    expect(rows.map((r) => r.text).join("")).toBe(text)
    const hit = rows.find((r) => r.ranges.length)!
    expect(hit.text.slice(...hit.ranges[0]!)).toBe("😀")
  })
})
