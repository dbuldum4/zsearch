/**
 * End-to-end tests: run zsearch in a real pseudo-terminal and read the screen with
 * pyte (a VT100 emulator). Skipped when python3 + pyte are not installed.
 *
 * Runs against `bun src/main.ts`, and also against `dist/zsearch` when it has been
 * built (`bun run build`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { defaultConfig } from "../src/config.ts"
import { makeCorpus } from "./helpers/corpus.ts"
import { writeTestModel } from "./helpers/model.ts"

const ROOT = join(import.meta.dir, "..")
const DRIVER = join(import.meta.dir, "e2e", "pty_driver.py")
const hasPyte = spawnSync("python3", ["-c", "import pyte"]).status === 0
const BIN = join(ROOT, "dist", "zsearch")

type Step = Record<string, unknown>
interface DriverResult {
  ok: boolean
  error: string | null
  exit: number | null
  snapshots: Record<string, string>
  final: string
  stdout_tail: string
}

function drive(cmd: string[], env: Record<string, string>, steps: Step[], size = { cols: 120, rows: 34 }): DriverResult {
  const specFile = join(env.HOME!, `.pty-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(specFile, JSON.stringify({ cmd, cwd: env.HOME, env, ...size, steps }))
  const r = spawnSync("python3", [DRIVER, specFile], { encoding: "utf8", timeout: 120_000 })
  if (r.status !== 0) throw new Error(`driver failed: ${r.stderr}`)
  const out = JSON.parse(r.stdout) as DriverResult
  if (!out.ok) throw new Error(`${out.error}\n--- screen ---\n${out.snapshots.__timeout__ ?? out.final}`)
  return out
}

const variants: [string, string[]][] = [["source", ["bun", join(ROOT, "src", "main.ts")]]]
if (existsSync(BIN)) variants.push(["binary", [BIN]])

for (const [name, cmd] of variants) {
  describe.skipIf(!hasPyte)(`e2e (${name})`, () => {
    let corpus: ReturnType<typeof makeCorpus>
    let env: Record<string, string>

    beforeAll(() => {
      corpus = makeCorpus()
      env = { HOME: corpus.home, ZSEARCH_HOME: join(corpus.home, ".zsearch-data"), LANG: "en_US.UTF-8" }
    })
    afterAll(() => corpus.cleanup())

    test("first run: setup, indexing, search, preview, quit", () => {
      const r = drive(cmd, env, [
        { expect: "Welcome to zsearch", timeout: 20 },
        { snapshot: "welcome" },
        { key: "enter" },
        { expect: "Index ready", timeout: 30 },
        { type: "budget" },
        { expect: "auto → names + text", timeout: 10 },
        { expect: "3 results", timeout: 10 },
        { expect: "budget.xlsx", timeout: 10 },
        { snapshot: "results" },
        { key: "down" },
        { expect: "~/Documents/report.docx", timeout: 10 },
        { expect: "Quarterly Planning Report", timeout: 10 },
        { snapshot: "preview" },
        { key: "tab" },
        { expect: " FUZZY ", timeout: 5 },
        { key: "ctrl-c" },
        { wait_exit: 5 },
      ])
      expect(r.snapshots.welcome).toContain("Start indexing")
      expect(r.snapshots.results).toContain("budget.xlsx")
      expect(r.snapshots.results).toMatch(/3 results/)
      expect(r.snapshots.preview).toContain("Quarterly Planning Report")
      if (r.exit !== 0 || !r.stdout_tail.includes("\x1b[?1049l")) console.log("exit", r.exit, "final screen:\n" + r.final)
      expect(r.exit).toBe(0)
      // The terminal is restored (alternate screen left).
      expect(r.stdout_tail).toContain("\x1b[?1049l")
    })

    test("existing index: query from the command line, regex mode, help", () => {
      const r = drive([...cmd, "-m", "regex", "MAX_\\w+"], env, [
        { expect: "MAX_RETRIES = 42", timeout: 20 },
        { snapshot: "regex" },
        { key: "f1" },
        { expect: "zsearch help", timeout: 5 },
        { key: "esc" },
        { expect_not: "zsearch help", timeout: 5 },
        { key: "esc", delay: 0.3 },
        { key: "esc", delay: 0.3 },
        { wait_exit: 5 },
      ])
      expect(r.snapshots.regex).toContain("parse_config.py")
      expect(r.snapshots.regex).toContain(" REGEX ")
      expect(r.exit).toBe(0)
    })

    test("print mode writes the chosen path", () => {
      const r = drive([...cmd, "-p", "pancakes"], env, [{ expect: "pancakes.txt", timeout: 20 }, { sleep: 0.5 }, { key: "enter" }, { wait_exit: 5 }])
      expect(r.exit).toBe(0)
      expect(r.stdout_tail).toContain(join(corpus.home, "notes", "recipes", "pancakes.txt"))
    })

    test("print mode with redirected stdout draws on the terminal", () => {
      const out = join(corpus.home, "picked.txt")
      const shell = `${cmd.map((c) => `'${c}'`).join(" ")} -p pancakes > '${out}'`
      const r = drive(["sh", "-c", shell], env, [{ expect: "pancakes.txt", timeout: 20 }, { sleep: 0.5 }, { key: "enter" }, { wait_exit: 5 }])
      expect(r.exit).toBe(0)
      expect(readFileSync(out, "utf8").trim()).toBe(join(corpus.home, "notes", "recipes", "pancakes.txt"))
    })

    test("Ctrl-E opens a terminal editor at the matching line and returns", () => {
      const log = join(corpus.home, "editor-args.txt")
      const editor = join(corpus.home, "bin", "vim")
      mkdirSync(join(corpus.home, "bin"), { recursive: true })
      writeFileSync(editor, `#!/bin/sh\necho "$@" > ${log}\n`)
      chmodSync(editor, 0o755)
      const r = drive(cmd, { ...env, EDITOR: editor }, [
        { type: "MAX_RETRIES" },
        { expect: "parse_config.py", timeout: 20 },
        { sleep: 0.4 },
        { key: "ctrl-e", delay: 1 },
        { expect: "parse_config.py", timeout: 10 },
        { snapshot: "after" },
        { key: "ctrl-c" },
        { wait_exit: 5 },
      ])
      expect(readFileSync(log, "utf8").trim()).toBe(`+7 ${join(corpus.home, "code", "app", "src", "util", "parse_config.py")}`)
      expect(r.snapshots.after).toContain("zsearch")
      expect(r.exit).toBe(0)
    })

    test("semantic search with a local model", () => {
      const modelDir = writeTestModel(join(corpus.home, ".zsearch-data", "model"))
      const config = defaultConfig()
      config.semantic = { ...config.semantic, enabled: true, model: modelDir }
      writeFileSync(join(corpus.home, ".zsearch-data", "config.json"), JSON.stringify(config))
      const idx = spawnSync(cmd[0]!, [...cmd.slice(1), "index", "-q"], { env: { ...process.env, ...env }, encoding: "utf8" })
      if (idx.status !== 0) console.log(idx.stdout, idx.stderr)
      expect(idx.status).toBe(0)
      const r = drive([...cmd, "-m", "semantic", "cooking breakfast"], env, [
        { expect: "meaning + text", timeout: 20 },
        { snapshot: "sem" },
        { key: "ctrl-c" },
        { wait_exit: 5 },
      ])
      const firstResult = r.snapshots.sem!.split("\n").find((l) => l.startsWith("▌"))
      if (!firstResult?.includes("pancakes.txt")) console.log(r.snapshots.sem)
      expect(firstResult).toContain("pancakes.txt")
    })
  })
}
