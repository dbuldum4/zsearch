import { afterAll, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"
import { makeCorpus } from "./helpers/corpus.ts"

let corpus: ReturnType<typeof makeCorpus>
const MAIN = join(import.meta.dir, "..", "src", "main.ts")

beforeAll(() => {
  corpus = makeCorpus()
})
afterAll(() => corpus.cleanup())

/** Start `zsearch serve` and read its replies one JSON line at a time. */
function server() {
  const proc = Bun.spawn(["bun", MAIN, "serve"], {
    cwd: corpus.home,
    env: { ...process.env, HOME: corpus.home, ZSEARCH_HOME: join(corpus.home, ".zsearch-data") },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const queue: Record<string, unknown>[] = []
  const nextLine = async (): Promise<Record<string, unknown>> => {
    while (!queue.length) {
      const nl = buffer.indexOf("\n")
      if (nl >= 0) {
        queue.push(JSON.parse(buffer.slice(0, nl)))
        buffer = buffer.slice(nl + 1)
        continue
      }
      const { value, done } = await reader.read()
      if (done) throw new Error("server closed stdout")
      buffer += decoder.decode(value, { stream: true })
    }
    return queue.shift()!
  }
  /** Next message matching `pred`, skipping progress and refresh events. */
  const until = async (pred: (m: Record<string, unknown>) => boolean) => {
    for (;;) {
      const m = await nextLine()
      if (pred(m)) return m
    }
  }
  const send = (m: unknown) => {
    proc.stdin.write(typeof m === "string" ? m + "\n" : JSON.stringify(m) + "\n")
    proc.stdin.flush()
  }
  const reply = (id: number) => until((m) => m.id === id)
  return { proc, send, until, reply }
}

test("serve: index, search, preview and stats over JSON lines", async () => {
  const s = server()
  const ready = await s.until((m) => m.type === "ready")
  expect(ready.firstRun).toBe(true)
  expect(ready.files).toBe(0)
  expect((ready.config as { roots: string[] }).roots).toEqual(["~/Documents", "~/Downloads"])

  s.send({ id: 1, type: "setConfig", config: { roots: ["~"], bogus: true } })
  const cfg = await s.reply(1)
  expect(cfg.type).toBe("config")
  expect((cfg.config as { roots: string[] }).roots).toEqual(["~"])
  expect(cfg.config).not.toHaveProperty("bogus")
  // A patch changes only what it names: the folders set above stay.
  s.send({ id: 10, type: "setConfig", config: { exclude: ["*.nothing"] } })
  const patched = (await s.reply(10)).config as { roots: string[]; exclude: string[] }
  expect(patched.roots).toEqual(["~"])
  expect(patched.exclude).toEqual(["*.nothing"])

  s.send({ id: 2, type: "index" })
  expect((await s.reply(2)).type).toBe("ok")
  const done = await s.until((m) => m.type === "indexDone")
  expect(done.status).toBe("done")

  s.send({ id: 3, type: "search", query: "pancakes", mode: "find" })
  const res = await s.reply(3)
  expect(res.type).toBe("results")
  const hits = (res.response as { hits: { id: number; path: string }[] }).hits
  const hit = hits.find((h) => h.path.endsWith("pancakes.txt"))
  expect(hit).toBeDefined()

  s.send({ id: 4, type: "preview", file: hit!.id, query: "pancakes" })
  const pv = await s.reply(4)
  expect(pv.type).toBe("preview")
  expect((pv.preview as { lines: { text: string }[] }).lines.map((l) => l.text).join("\n")).toContain("Mix flour")

  s.send({ id: 40, type: "previews", files: [hit!.id, 999_999], query: "pancakes" })
  const batch = await s.reply(40)
  expect(batch.type).toBe("previews")
  const previews = batch.previews as { id: number; message?: string }[]
  expect(previews.map((p) => p.id)).toEqual([hit!.id, 999_999])
  expect(previews[1]!.message).toBeDefined()

  // Rebuilding empties the index in place and indexes again.
  s.send({ id: 41, type: "index", rebuild: true })
  expect(await s.reply(41)).toEqual({ id: 41, type: "ok" })
  expect((await s.until((m) => m.type === "indexDone")).status).toBe("done")
  s.send({ id: 42, type: "search", query: "pancakes", mode: "find" })
  expect(((await s.reply(42)).response as { hits: { path: string }[] }).hits.some((h) => h.path.endsWith("pancakes.txt"))).toBe(true)

  s.send({ id: 5, type: "stats" })
  const st = await s.reply(5)
  expect((st.stats as { files: number }).files).toBeGreaterThan(5)

  s.send("not json")
  expect(String((await s.until((m) => m.type === "error")).error)).toContain("bad request")
  s.send({ id: 6, type: "nope" })
  expect((await s.reply(6)).type).toBe("error")

  s.proc.stdin.end()
  expect(await s.proc.exited).toBe(0)
}, 60_000)
