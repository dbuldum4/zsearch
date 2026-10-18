import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { acquireLock } from "../src/index/lock.ts"
import { makeCorpus } from "./helpers/corpus.ts"

let corpus: ReturnType<typeof makeCorpus>
const MAIN = join(import.meta.dir, "..", "src", "main.ts")

beforeAll(() => {
  corpus = makeCorpus()
})
afterAll(() => corpus.cleanup())

/** Start `zsearch serve` and read its replies one JSON line at a time. */
function server(env: Record<string, string> = {}, data = ".zsearch-data") {
  const proc = Bun.spawn(["bun", MAIN, "serve"], {
    cwd: corpus.home,
    env: { ...process.env, HOME: corpus.home, ZSEARCH_HOME: join(corpus.home, data), ...env },
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

test("serve: opting out of transcription cancels the active recording", async () => {
  const media = corpus.write("speech/meeting.wav", "stand-in audio")
  const marker = join(corpus.home, "speech-started")
  const helper = corpus.write("speech-helper", `#!${process.execPath}\nimport { writeFileSync } from "node:fs"\nif (process.argv[2] === "--prepare") { console.log('{"ready":true}'); process.exit(0) }\nwriteFileSync(${JSON.stringify(marker)}, "started")\nsetInterval(() => {}, 1000)\n`)
  chmodSync(helper, 0o700)
  const s = server({ ZSEARCH_TRANSCRIBE: helper }, ".speech-index")
  try {
    await s.until((m) => m.type === "ready")
    s.send({ id: 1, type: "setConfig", config: { roots: [media], autoRefreshMinutes: 0, liveUpdates: false, semantic: { enabled: false } } })
    await s.reply(1)
    s.send({ id: 2, type: "index" })
    await s.reply(2)
    const deadline = Date.now() + 10_000
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10)
    expect(existsSync(marker)).toBe(true)
    s.send({ id: 3, type: "setConfig", config: { content: { transcribe: false } } })
    expect((await s.reply(3)).type).toBe("config")
    expect((await s.until((m) => m.type === "indexDone")).status).toBe("cancelled")
    s.proc.stdin.end()
    expect(await s.proc.exited).toBe(0)
  } finally { s.proc.kill() }
}, 30_000)

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
  const configPath = join(corpus.home, ".zsearch-data", "config.json")
  const external = JSON.parse(readFileSync(configPath, "utf8"))
  external.roots = ["~", "~/another-frontend-root"]
  writeFileSync(configPath, JSON.stringify(external))
  // A patch changes only what it names: the folders set above stay.
  s.send({ id: 10, type: "setConfig", config: { exclude: ["*.nothing"] } })
  const patched = (await s.reply(10)).config as { roots: string[]; exclude: string[] }
  expect(patched.roots).toEqual(["~", "~/another-frontend-root"])
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
  // Each file's preview centres on its hit's line when one is given, as a single preview's does.
  expect((previews[0] as { focusLine?: number }).focusLine).toBe(1)
  s.send({ id: 42, type: "previews", files: [hit!.id, 999_999], focusLines: [3, null], query: "pancakes" })
  const focused = (await s.reply(42)).previews as { id: number; focusLine: number }[]
  expect(focused.map((p) => [p.id, p.focusLine])).toEqual([
    [hit!.id, 3],
    [999_999, 1],
  ])

  // Rebuilding empties the index in place and indexes again.
  s.send({ id: 41, type: "index", rebuild: true })
  expect(await s.reply(41)).toEqual({ id: 41, type: "ok" })
  expect((await s.until((m) => m.type === "indexDone")).status).toBe("done")
  s.send({ id: 42, type: "search", query: "pancakes", mode: "find" })
  expect(((await s.reply(42)).response as { hits: { path: string }[] }).hits.some((h) => h.path.endsWith("pancakes.txt"))).toBe(true)

  s.send({ id: 5, type: "stats" })
  const st = await s.reply(5)
  expect((st.stats as { files: number }).files).toBeGreaterThan(5)

  // How long a first index would take, counted on a worker.
  s.send({ id: 7, type: "estimate", roots: ["~/Documents", "~/notes"] })
  const est = await s.reply(7)
  expect(est.type).toBe("estimate")
  expect((est.estimates as { root: string }[]).map((e) => e.root)).toEqual(["~/Documents", "~/notes"])
  expect((est.total as { files: number; complete: boolean }).files).toBeGreaterThan(2)
  expect(String(est.text)).toMatch(/files · /)
  s.send({ id: 8, type: "estimate", roots: [] })
  expect((await s.reply(8)).type).toBe("error")

  s.send("not json")
  expect(String((await s.until((m) => m.type === "error")).error)).toContain("bad request")
  s.send({ id: 6, type: "nope" })
  expect((await s.reply(6)).type).toBe("error")

  s.proc.stdin.end()
  expect(await s.proc.exited).toBe(0)
}, 60_000)

test("serve: meaningIndex without meaning on fails without touching the word index", async () => {
  const s = server({}, ".zsearch-meaning-data")
  await s.until((m) => m.type === "ready")
  s.send({ id: 1, type: "meaningIndex" })
  expect((await s.reply(1)).type).toBe("ok")
  const done = await s.until((m) => m.type === "indexDone")
  expect(done.status).toBe("error")
  expect(String(done.error ?? (done.progress as { error?: string })?.error ?? "")).toContain("semantic search cannot run")
  s.proc.stdin.end()
  expect(await s.proc.exited).toBe(0)
}, 60_000)

test("serve: meaningIndex on a fresh install reads the files first", async () => {
  // The models as if downloaded already: files of their sizes (unchecked, with $ZSEARCH_MODELS).
  const models = join(corpus.home, ".models-fresh")
  mkdirSync(models, { recursive: true })
  const fd = openSync(join(models, "granite-embedding-small-english-r2.Q8_0.gguf"), "w")
  ftruncateSync(fd, 52_445_632)
  closeSync(fd)
  const helper = join(models, "fake-embed")
  writeFileSync(helper, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "helpers", "fake-embed.ts")}" "$@"\n`)
  chmodSync(helper, 0o755)
  corpus.write("fresh/note.txt", "wombatic semaphore\n")
  const s = server({ ZSEARCH_MODELS: models, ZSEARCH_EMBED: helper }, ".zsearch-fresh")
  await s.until((m) => m.type === "ready")
  // What "Only when I ask" saves, with semantic search on: nothing has been read yet.
  s.send({ id: 1, type: "setConfig", config: { roots: ["~/fresh"], autoRefreshMinutes: 0, liveUpdates: false, semantic: { enabled: true, declined: false, code: false } } })
  await s.reply(1)
  s.send({ id: 2, type: "meaningIndex" })
  expect((await s.reply(2)).type).toBe("ok")
  const done = await s.until((m) => m.type === "indexDone")
  expect(done.status).toBe("done")
  const p = done.progress as { added: number; meaning?: { total: number } }
  expect(p.added).toBeGreaterThan(0)
  expect(p.meaning?.total).toBeGreaterThan(0)
  // Read once: the next one embeds the stored text without scanning again.
  s.send({ id: 3, type: "meaningIndex" })
  await s.reply(3)
  const again = await s.until((m) => m.type === "indexDone")
  expect((again.progress as { scanned: number }).scanned).toBe(0)
  s.proc.stdin.end()
  expect(await s.proc.exited).toBe(0)
}, 60_000)

test("serve: with no schedule and no live updates, the index changes only when asked", async () => {
  const s = server()
  await s.until((m) => m.type === "ready")
  // What the Mac app's "Only when I ask" saves.
  s.send({ id: 1, type: "setConfig", config: { roots: ["~"], autoRefreshMinutes: 0, liveUpdates: false } })
  const cfg = (await s.reply(1)).config as { autoRefreshMinutes: number; liveUpdates: boolean }
  expect([cfg.autoRefreshMinutes, cfg.liveUpdates]).toEqual([0, false])
  s.send({ id: 2, type: "index" })
  await s.reply(2)
  await s.until((m) => m.type === "indexDone")

  corpus.write("notes/manual-only.txt", "quokkatronic marmalade\n")
  // Live updates would start an update about a second after the change.
  await Bun.sleep(3000)
  s.send({ id: 3, type: "search", query: "quokkatronic", mode: "find" })
  const seen: unknown[] = []
  const found = await s.until((m) => (seen.push(m.type), m.id === 3))
  expect(seen).not.toContain("indexProgress")
  expect((found.response as { hits: unknown[] }).hits).toHaveLength(0)

  s.send({ id: 4, type: "index" })
  await s.reply(4)
  await s.until((m) => m.type === "indexDone")
  s.send({ id: 5, type: "search", query: "quokkatronic", mode: "find" })
  expect(((await s.reply(5)).response as { hits: unknown[] }).hits).toHaveLength(1)

  s.proc.stdin.end()
  expect(await s.proc.exited).toBe(0)
}, 60_000)

test("serve: only updates that started on their own wait on power, and asking for one ends the wait", async () => {
  for (let i = 0; i < 1100; i++) corpus.write(`bulk/file-${i}.txt`, `bulk word number${i}\n`)
  // The computer as if in Low Power Mode, with an index of its own.
  const s = server({ ZSEARCH_POWER: "low-power" }, ".zsearch-power")
  await s.until((m) => m.type === "ready")
  s.send({ id: 1, type: "setConfig", config: { roots: ["~/bulk"] } })
  await s.reply(1)

  // Asked for: never waits.
  s.send({ id: 2, type: "index" })
  expect((await s.reply(2)).type).toBe("ok")
  const progress: { waiting?: string }[] = []
  const first = await s.until((m) => {
    if (m.type === "indexProgress") progress.push(m.progress as { waiting?: string })
    return m.type === "indexDone"
  })
  expect(first.status).toBe("done")
  expect(progress.some((p) => p.waiting)).toBe(false)

  // Started on its own, with everything to read again: waits...
  s.send({ id: 3, type: "index", rebuild: true, background: true })
  expect((await s.reply(3)).type).toBe("ok")
  const waiting = await s.until((m) => m.type === "indexProgress" && Boolean((m.progress as { waiting?: string }).waiting))
  expect((waiting.progress as { waiting: string; contentDone: number }).waiting).toBe("Low Power Mode")
  const held = waiting.progress as { contentDone: number; contentTotal: number }
  expect(held.contentDone).toBeLessThan(held.contentTotal)
  // ...until someone asks for an update, which the running one becomes.
  s.send({ id: 4, type: "index" })
  expect((await s.reply(4)).type).toBe("ok")
  const done = await s.until((m) => m.type === "indexDone")
  expect(done.status).toBe("done")
  const p = done.progress as { contentDone: number; contentTotal: number; waiting?: string }
  expect(p.contentDone).toBe(p.contentTotal)
  expect(p.waiting).toBeUndefined()

  s.proc.stdin.end()
  expect(await s.proc.exited).toBe(0)
}, 60_000)

test("serve: semantic search installed while an update runs gets a run of its own after it", async () => {
  for (let i = 0; i < 1100; i++) corpus.write(`bulk/file-${i}.txt`, `bulk word number${i}\n`)
  // The models as if downloaded already: files of their sizes (unchecked, with $ZSEARCH_MODELS).
  const models = join(corpus.home, ".models")
  mkdirSync(models, { recursive: true })
  for (const [name, bytes] of [["granite-embedding-small-english-r2.Q8_0.gguf", 52_445_632]] as const) {
    const fd = openSync(join(models, name), "w")
    ftruncateSync(fd, bytes)
    closeSync(fd)
  }
  const helper = join(models, "fake-embed")
  writeFileSync(helper, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "helpers", "fake-embed.ts")}" "$@"\n`)
  chmodSync(helper, 0o755)
  const s = server({ ZSEARCH_POWER: "low-power", ZSEARCH_MODELS: models, ZSEARCH_EMBED: helper }, ".zsearch-install")
  await s.until((m) => m.type === "ready")
  s.send({ id: 1, type: "setConfig", config: { roots: ["~/bulk"], semantic: { enabled: false, declined: false, code: false } } })
  await s.reply(1)
  // An update that started on its own, before semantic search was on, waits on power...
  s.send({ id: 2, type: "index", background: true })
  await s.reply(2)
  await s.until((m) => m.type === "indexProgress" && Boolean((m.progress as { waiting?: string }).waiting))
  // ...while the models install.
  s.send({ id: 3, type: "semanticInstall" })
  expect((await s.reply(3)).type).toBe("semantic")
  s.send({ id: 4, type: "index" })
  await s.reply(4)
  const first = await s.until((m) => m.type === "indexDone")
  expect((first.progress as { meaning?: unknown }).meaning).toBeUndefined()
  // The run that follows has semantic search on.
  const next = await s.until((m) => m.type === "indexProgress" || m.type === "indexDone")
  expect(next.type).toBe("indexProgress")
  s.send({ id: 5, type: "index" })
  await s.reply(5)
  const second = await s.until((m) => m.type === "indexDone")
  expect((second.progress as { meaning?: unknown }).meaning).toBeDefined()
  s.proc.stdin.end()
  expect(await s.proc.exited).toBe(0)
}, 60_000)

test("serve: indexing problems are listed, explained and read again", async () => {
  corpus.write("problems/broken.docx", "not really a docx")
  corpus.write("problems/keys/server.pem", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n")
  corpus.write("problems/fine.txt", "wallaby ledger\n")
  const s = server({}, ".zsearch-problems")
  await s.until((m) => m.type === "ready")
  s.send({ id: 1, type: "setConfig", config: { roots: ["~/problems"], autoRefreshMinutes: 0, liveUpdates: false } })
  await s.reply(1)
  s.send({ id: 2, type: "index" })
  await s.reply(2)
  expect((await s.until((m) => m.type === "indexDone")).status).toBe("done")

  s.send({ id: 3, type: "problems", categories: ["unreadable", "secret", "bogus"], limit: 10 })
  const list = await s.reply(3)
  expect(list.type).toBe("problems")
  const problems = list.problems as { path: string; category: string; reason: string; detail: string | null; retry: boolean }[]
  expect(problems.map((p) => [p.path.split("/").pop(), p.category, p.retry])).toEqual([
    ["broken.docx", "unreadable", true],
    ["server.pem", "secret", false],
  ])
  expect(problems[0]!.detail).toContain("not a valid Office file")
  expect(list.total).toBe(2)
  expect((list.categories as { category: string; count: number }[]).map((c) => [c.category, c.count])).toEqual([
    ["unreadable", 1],
    ["secret", 1],
  ])
  s.send({ id: 4, type: "problems", query: "server" })
  expect(((await s.reply(4)).problems as unknown[]).length).toBe(1)

  s.send({ id: 5, type: "explain", path: "~/problems/fine.txt" })
  expect(((await s.reply(5)).explanation as { searchable: string }).searchable).toBe("content")
  s.send({ id: 6, type: "explain", path: "~/problems/broken.docx" })
  expect((await s.reply(6)).explanation).toMatchObject({ searchable: "name", category: "unreadable", retry: true })

  // Keys are never read: a retry is refused, with why.
  s.send({ id: 7, type: "retryProblems", category: "secret" })
  expect(String((await s.reply(7)).error)).toContain("never read")
  s.send({ id: 8, type: "retryProblems", category: "nonsense" })
  expect((await s.reply(8)).type).toBe("error")
  s.send({ id: 9, type: "retryProblems", paths: [join(corpus.home, "problems/broken.docx"), "~/problems/keys/server.pem"] })
  const retried = await s.reply(9)
  expect(retried).toMatchObject({ type: "retried", retried: 1, reading: "now" })
  expect((retried.refused as { path: string }[]).map((r) => r.path.split("/").pop())).toEqual(["server.pem"])
  // An update starts on its own and reads it again, even with updates only when asked.
  const done = await s.until((m) => m.type === "indexDone")
  expect((done.progress as { contentErrors: number }).contentErrors).toBe(1)

  s.proc.stdin.end()
  expect(await s.proc.exited).toBe(0)
}, 60_000)

test("serve: a retry while another process updates starts its own update when that finishes", async () => {
  corpus.write("held/broken.docx", "not really a docx")
  const s = server({}, ".zsearch-held")
  try {
    await s.until((m) => m.type === "ready")
    s.send({ id: 1, type: "setConfig", config: { roots: ["~/held"], autoRefreshMinutes: 0, liveUpdates: false, semantic: { enabled: false } } })
    await s.reply(1)
    s.send({ id: 2, type: "index" })
    await s.reply(2)
    expect((await s.until((m) => m.type === "indexDone")).status).toBe("done")

    // Another zsearch process holds the lock: the file is marked, but no run can start.
    const release = acquireLock(join(corpus.home, ".zsearch-held", "index.lock"))!
    s.send({ id: 3, type: "retryProblems", category: "unreadable" })
    expect(await s.reply(3)).toMatchObject({ type: "retried", retried: 1, reading: "waiting" })
    s.send({ id: 4, type: "index" })
    expect(String((await s.reply(4)).error)).toContain("another zsearch process")

    // When it lets go, the marked file is read without being asked again.
    release()
    const done = await s.until((m) => m.type === "indexDone")
    expect(done.status).toBe("done")
    expect((done.progress as { contentErrors: number }).contentErrors).toBe(1)
    s.proc.stdin.end()
    expect(await s.proc.exited).toBe(0)
  } finally { s.proc.kill() }
}, 60_000)

test("serve: files marked during a run are read by a following run, even when it is cancelled", async () => {
  corpus.write("hold/broken.docx", "not really a docx")
  const started = join(corpus.home, "transcribe-started")
  const go = join(corpus.home, "transcribe-go")
  // A transcription helper that blocks until `go` exists: the run stays in progress.
  const helper = corpus.write("transcribe-helper", `#!${process.execPath}\nimport { writeFileSync, existsSync } from "node:fs"\nif (process.argv[2] === "--prepare") process.exit(0)\nwriteFileSync(${JSON.stringify(started)}, "started")\nwhile (!existsSync(${JSON.stringify(go)})) Bun.sleepSync(50)\nconsole.log('{"complete":true}')\n`)
  chmodSync(helper, 0o700)
  const s = server({ ZSEARCH_TRANSCRIBE: helper }, ".zsearch-hold")
  try {
    await s.until((m) => m.type === "ready")
    s.send({ id: 1, type: "setConfig", config: { roots: ["~/hold"], autoRefreshMinutes: 0, liveUpdates: false, semantic: { enabled: false } } })
    await s.reply(1)
    s.send({ id: 2, type: "index" })
    await s.reply(2)
    expect((await s.until((m) => m.type === "indexDone")).status).toBe("done")

    // A run that stays in progress, transcribing the recording.
    corpus.write("hold/meeting.wav", "stand-in audio")
    s.send({ id: 3, type: "index" })
    await s.reply(3)
    const deadline = Date.now() + 15_000
    while (!existsSync(started) && Date.now() < deadline) await Bun.sleep(20)
    expect(existsSync(started)).toBe(true)

    // Marked while that run is going: read by the one that follows it, however it ends.
    s.send({ id: 4, type: "retryProblems", category: "unreadable" })
    expect(await s.reply(4)).toMatchObject({ type: "retried", retried: 1, reading: "next" })
    s.send({ id: 5, type: "cancelIndex" })
    await s.reply(5)
    expect((await s.until((m) => m.type === "indexDone")).status).toBe("cancelled")
    writeFileSync(go, "go")
    const done = await s.until((m) => m.type === "indexDone" && m.status === "done")
    expect((done.progress as { contentErrors: number }).contentErrors).toBe(1)
    s.proc.stdin.end()
    expect(await s.proc.exited).toBe(0)
  } finally { s.proc.kill() }
}, 60_000)

test("serve: after the index is reset, problems come from the new file", async () => {
  corpus.write("resettable/broken.docx", "not really a docx")
  const s = server({}, ".zsearch-reset")
  try {
    await s.until((m) => m.type === "ready")
    s.send({ id: 1, type: "setConfig", config: { roots: ["~/resettable"], autoRefreshMinutes: 0, liveUpdates: false, semantic: { enabled: false } } })
    await s.reply(1)
    s.send({ id: 2, type: "index" })
    await s.reply(2)
    expect((await s.until((m) => m.type === "indexDone")).status).toBe("done")
    s.send({ id: 3, type: "problems" })
    expect((await s.reply(3)).total).toBe(1)

    // `zsearch reset`: the index file goes away; the next run builds a new one.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(corpus.home, ".zsearch-reset", `index.db${suffix}`), { force: true })
    s.send({ id: 4, type: "problems" })
    expect((await s.reply(4)).total).toBe(0)
    s.send({ id: 5, type: "explain", path: "~/resettable/broken.docx" })
    expect((await s.reply(5)).explanation).toMatchObject({ searchable: "none" })
    s.proc.stdin.end()
    expect(await s.proc.exited).toBe(0)
  } finally { s.proc.kill() }
}, 60_000)
