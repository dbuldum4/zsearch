import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { defaultConfig, mergeConfig, withConfigSetting } from "../src/config.ts"
import { ContentState, openDb } from "../src/index/db.ts"
import { DEFAULT_EXTRACT, extract, wantsContent } from "../src/index/extract/index.ts"
import { transcribe } from "../src/index/extract/transcribe.ts"
import { Indexer } from "../src/index/indexer.ts"
import { ExtractPool } from "../src/index/pool.ts"
import { describeEstimate, estimateFolder } from "../src/index/estimate.ts"
import { transcriptionToolPath } from "../src/platform.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { readIndexed } from "../src/search/read.ts"
import { SemanticIndexer } from "../src/semantic/indexer.ts"

let dir: string, helper: string
const env = { ZSEARCH_TRANSCRIBE: process.env.ZSEARCH_TRANSCRIBE, ZSEARCH_HOME: process.env.ZSEARCH_HOME }
const script = (name: string, body: string) => {
  const path = join(dir, name)
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 })
  return path
}
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zsearch-transcribe-"))
  helper = script("speech helper", `
import { appendFileSync, closeSync, openSync, unlinkSync } from "node:fs"
if (process.argv[2] === "--prepare") { console.log('{"ready":true}'); process.exit(0) }
const lock = ${JSON.stringify(join(dir, "active"))}
try { closeSync(openSync(lock, "wx")) } catch { console.error("overlapping transcription"); process.exit(1) }
appendFileSync(${JSON.stringify(join(dir, "calls"))}, JSON.stringify(process.argv.slice(2)) + "\\n")
await Bun.sleep(10)
console.log(JSON.stringify({start: 83.5, text: "Orion telescope budget approved"}))
console.log(JSON.stringify({start: 95, text: "Bring the blue notebook"}))
console.log(JSON.stringify({complete: true, truncated: false}))
unlinkSync(lock)
`)
  process.env.ZSEARCH_TRANSCRIBE = helper
  process.env.ZSEARCH_HOME = join(dir, "private-index")
})
afterAll(() => {
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  rmSync(dir, { recursive: true, force: true })
})

describe("on-device speech extraction", () => {
  test("only supported media and an available helper opt into transcription", async () => {
    expect(wantsContent("mp4", "video")).toBe(false)
    expect(wantsContent("mp4", "video", false, false, true)).toBe(true)
    expect(wantsContent("mkv", "video", false, false, true)).toBe(false)
    expect(transcriptionToolPath()).toBe(helper)
    process.env.ZSEARCH_TRANSCRIBE = "0"
    expect(transcriptionToolPath()).toBeNull()
    process.env.ZSEARCH_TRANSCRIBE = helper
    const file = join(dir, "recording.mp4")
    writeFileSync(file, "stand-in media")
    expect(await extract(file, 14, "mp4", "video")).toEqual({ status: "skip", reason: "unsupported" })
    // A large container is streamed by the helper, not loaded under the 64 MB document cap.
    const result = await extract(file, 4 * 1024 ** 3, "mp4", "video", { ...DEFAULT_EXTRACT, transcriptionTool: helper, transcriptionLocale: "tr-TR" })
    expect(result).toEqual({ status: "ok", text: "[00:01:23] Orion telescope budget approved\n[00:01:35] Bring the blue notebook", truncated: false })
    const args = JSON.parse(readFileSync(join(dir, "calls"), "utf8").trim().split("\n").at(-1)!) as string[]
    expect(args).toContain(file)
    expect(args).toContain("tr-TR")
    expect(args).toContain("7200")
  })

  test("final segments survive interruption, but an incomplete segment does not", async () => {
    const interrupted = script("interrupted", `
process.stdout.write(JSON.stringify({start: 5, text: "final segment"}) + "\\n" + '{"start":10,"text":"unfinished')
process.kill(process.pid, "SIGTERM")
`)
    expect(await transcribe(interrupted, "unused", "", 100)).toEqual({ text: "[00:00:05] final segment", truncated: true })
    const broken = script("broken", 'console.error("unsupported spoken language"); process.exit(1)')
    await expect(transcribe(broken, "unused", "", 100)).rejects.toThrow("unsupported spoken language")
    const invalid = script("invalid", 'console.log(JSON.stringify({start: -1, text: "invalid"}))')
    await expect(transcribe(invalid, "unused", "", 100)).rejects.toThrow("invalid transcription response")
  })

  test("deadlines stop the helper and preserve finalized text", async () => {
    const stalled = script("stalled", 'console.log(JSON.stringify({start: 0, text: "finished words"})); setInterval(() => {}, 1000)')
    expect(await transcribe(stalled, "unused", "", 100, 1000)).toEqual({ text: "[00:00:00] finished words", truncated: true })
  })

  test("character and duration limits are marked partial", async () => {
    const limited = script("limited", 'console.log(JSON.stringify({start: 0, text: "some speech"})); console.log(JSON.stringify({complete: true, truncated: true}))')
    expect(await transcribe(limited, "unused", "", 100)).toMatchObject({ truncated: true })
    const result = await transcribe(helper, "unused", "", 15)
    expect(result.text.length).toBeLessThanOrEqual(15)
    expect(result.truncated).toBe(true)
  })

  test("a failed asset download is attempted only once per run", async () => {
    const log = join(dir, "prepare-calls")
    const unavailable = script("assets-unavailable", `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, "attempt\\n"); console.error("speech assets unavailable offline"); process.exit(1)`)
    for (let i = 0; i < 3; i++) await expect(transcribe(unavailable, "unused", "en-US", 100, 5000, "offline-pass")).rejects.toThrow("offline")
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1)
    await expect(transcribe(unavailable, "unused", "en-US", 100, 5000, "next-pass")).rejects.toThrow("offline")
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2)
  })

  test("the worker pool cancels an in-flight speech helper", async () => {
    const pidFile = join(dir, "cancel-pid"), heartbeat = join(dir, "heartbeat")
    const stalled = script("cancelled", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 25)`)
    const pool = new ExtractPool(1, { ...DEFAULT_EXTRACT, transcriptionTool: stalled }, 1)
    const file = join(dir, "cancel.wav"); writeFileSync(file, "fake media")
    const reply = pool.run({ id: 1, path: file, size: 10, ext: "wav", kind: "audio", run: "cancel" })
    try {
      const deadline = Date.now() + 5000
      while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(10)
      expect(existsSync(pidFile)).toBe(true)
      pool.close()
      expect(await reply).toMatchObject({ status: "error", error: "cancelled" })
      // A terminated worker's child can briefly remain a zombie; test that execution stopped.
      await Bun.sleep(100)
      const last = existsSync(heartbeat) ? readFileSync(heartbeat, "utf8") : ""
      await Bun.sleep(150)
      expect(existsSync(heartbeat) ? readFileSync(heartbeat, "utf8") : "").toBe(last)
    } finally { pool.close() }
  })
})

test("transcripts are searchable, serial, reused, and hidden immediately on opt-out", async () => {
  const root = join(dir, "media"); mkdirSync(root)
  for (const name of ["a.mp3", "b.mp4", "c.wav"]) writeFileSync(join(root, name), "fake audio data")
  writeFileSync(join(root, "notes.txt"), "Ordinary documents go first")
  const config = { ...defaultConfig(), roots: [root], indexLoad: 100, workers: 3 }
  const db = openDb(join(dir, "speech-index.db"))
  try {
    const before = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").length
    const p = await new Indexer(db, config).run()
    expect(p.phase).toBe("done")
    expect(p.contentErrors).toBe(0) // The helper rejects any overlapping invocation.
    expect(p.contentDone).toBe(4)
    const engine = new SearchEngine(db, config)
    const found = await engine.search("telescope")
    expect(found.hits).toHaveLength(3)
    expect(engine.preview(found.hits[0]!.id, "telescope", "find").lines[0]?.text).toContain("[00:01:23]")
    const read = () => readIndexed(engine, found.hits[0]!.path, "", "find", { lines: 5, maxChars: 1000 })
    expect(read()?.source).toBe("index")
    const again = await new Indexer(db, config).run()
    expect(again.contentDone).toBe(0)
    expect(readFileSync(join(dir, "calls"), "utf8").trim().split("\n").length).toBe(before + 3)
    const embedded: string[] = []
    const meanings = await new SemanticIndexer(db, config, null, { vectorVersion: 1, embedder: () => ({
      async embedTexts(texts) {
        embedded.push(...texts)
        const dim = 8, vectors = new Float32Array(texts.length * dim)
        for (let i = 0; i < texts.length; i++) vectors[i * dim] = 1
        return { vectors, dim, tokens: texts.length }
      },
      close() {}, kill() {},
    }) }).run()
    expect(meanings.status).toBe("done")
    expect(embedded.some((text) => text.includes("Orion telescope budget"))).toBe(true)

    const off = { ...config, content: { ...config.content, transcribe: false } }
    engine.config = off
    expect((await engine.search("telescope")).hits).toHaveLength(0)
    expect((await engine.search("a.mp3")).hits.map((h) => basename(h.path))).toEqual(["a.mp3"])
    expect(engine.preview(found.hits[0]!.id, "telescope", "find").lines).toEqual([])
    expect(read()?.source).toBe("none")
    const disabled = await new Indexer(db, off).run()
    expect(disabled.contentDone).toBe(0) // Changing speech policy must not re-extract documents.
    expect(db.query("SELECT count(*) AS n FROM content WHERE id IN (SELECT id FROM files WHERE kind IN ('audio', 'video'))").get()).toEqual({ n: 0 })
    await new Indexer(db, config).run()
    expect(db.query("SELECT count(*) AS n FROM files WHERE kind IN ('audio', 'video') AND content_state = ?").get(ContentState.Indexed)).toEqual({ n: 3 })
    const changedLanguage = await new Indexer(db, { ...config, content: { ...config.content, transcriptionLocale: "en-US" } }).run()
    expect(changedLanguage.contentDone).toBe(3)
    engine.config = { ...off, namesOnly: [root] }
    expect(engine.preview(found.hits[0]!.id, "", "find").contentAllowed).toBe(false)
  } finally { db.close() }
})

test("speech settings default on, preserve older configs, validate locale, and inform estimates", () => {
  const config = mergeConfig(defaultConfig(), { content: { ocr: false } })
  expect(config.content.transcribe).toBe(true)
  expect(withConfigSetting(config, "content.transcribe", "false").content.transcribe).toBe(false)
  expect(withConfigSetting(config, "content.transcriptionLocale", "tr-TR").content.transcriptionLocale).toBe("tr-TR")
  expect(() => withConfigSetting(config, "content.transcriptionLocale", "not a locale")).toThrow("language code")
  const e = estimateFolder(join(dir, "media"), { ...config, roots: [join(dir, "media")] })
  expect(e.mediaFiles).toBe(3)
  expect(describeEstimate(e)).toContain("depends on duration")
})
