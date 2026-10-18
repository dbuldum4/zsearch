import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig } from "../src/config.ts"
import { RootWatcher } from "../src/index/watch.ts"

type Internals = { add(path: string | null): void; roots: string[] }

// Exercise event coalescing without depending on platform watcher delivery.
function notify(watcher: RootWatcher, path: string | null = "/r/file.txt") {
  (watcher as unknown as Internals).add(path)
}
function watching(watcher: RootWatcher, roots: string[]) {
  (watcher as unknown as Internals).roots = roots
  return watcher
}

test("continuous file events refresh within the maximum wait and keep refreshing", async () => {
  let calls = 0
  const watcher = new RootWatcher(() => { calls++ }, 100, 180)
  const events = setInterval(() => notify(watcher), 20)
  try {
    notify(watcher)
    await Bun.sleep(450)
    expect(calls).toBeGreaterThanOrEqual(2)
    clearInterval(events)
    await Bun.sleep(150)
    expect(calls).toBeGreaterThanOrEqual(3)
  } finally { clearInterval(events); watcher.close() }
})

test("quiet bursts refresh once and closing cancels both deadlines", async () => {
  let calls = 0
  const watcher = new RootWatcher(() => { calls++ }, 30, 150)
  try {
    notify(watcher); notify(watcher); notify(watcher)
    await Bun.sleep(200)
    expect(calls).toBe(1)
    notify(watcher)
    watcher.close()
    await Bun.sleep(200)
    expect(calls).toBe(1)
  } finally { watcher.close() }
})

test("a busy index retries even while more file events arrive", async () => {
  let calls = 0
  const watcher = new RootWatcher(() => { calls++; return calls > 1 }, 100, 180)
  const events = setInterval(() => notify(watcher), 20)
  try {
    notify(watcher)
    await Bun.sleep(450)
    expect(calls).toBeGreaterThanOrEqual(2)
  } finally { clearInterval(events); watcher.close() }
})

test("a refresh gets the changed paths once, without those inside another", async () => {
  const got: (string[] | null)[] = []
  const watcher = watching(new RootWatcher((paths) => { got.push(paths) }, 20, 200), ["/r"])
  try {
    for (const p of ["/r/a/one.txt", "/r/a/one.txt", "/r/b", "/r/b/inner/x.txt", "/r/c.txt"]) notify(watcher, p)
    await Bun.sleep(80)
    expect(got.length).toBe(1)
    expect(got[0]!.sort()).toEqual(["/r/a/one.txt", "/r/b", "/r/c.txt"])
  } finally { watcher.close() }
})

test("many changes in one folder stand for the folder, but never above the roots", async () => {
  const got: (string[] | null)[] = []
  const watcher = watching(new RootWatcher((paths) => { got.push(paths) }, 20, 200), ["/r/a", "/r/b"])
  try {
    for (let i = 0; i < 200; i++) notify(watcher, `/r/a/logs/${i}.log`)
    for (let i = 0; i < 200; i++) notify(watcher, `/r/x${i}`)
    notify(watcher, "/r/b/kept.txt")
    await Bun.sleep(80)
    expect(got[0]!.filter((p) => p.startsWith("/r/a") || p.startsWith("/r/b")).sort()).toEqual(["/r/a/logs", "/r/b/kept.txt"])
    // Folders above the roots are never walked in place of what changed in them.
    expect(got[0]!.length).toBe(202)
  } finally { watcher.close() }
})

test("too many changes, an event without a path, or a busy index merging those, walk every root", async () => {
  const got: (string[] | null)[] = []
  let busy = false
  const watcher = watching(new RootWatcher((paths) => { if (busy) return false; got.push(paths) }, 20, 200), ["/r"])
  try {
    for (let i = 0; i < 1001; i++) notify(watcher, `/r/d${i}/f.txt`)
    await Bun.sleep(80)
    expect(got).toEqual([null])
    notify(watcher, null)
    await Bun.sleep(80)
    expect(got).toEqual([null, null])
    // Waiting for a busy index keeps what changed meanwhile, and adds what changes next.
    busy = true
    notify(watcher, "/r/first.txt")
    await Bun.sleep(40)
    notify(watcher, "/r/second.txt")
    busy = false
    await Bun.sleep(80)
    expect(got[2]!.sort()).toEqual(["/r/first.txt", "/r/second.txt"])
  } finally { watcher.close() }
})

test("what a refresh did not finish waits for the next one", async () => {
  const got: (string[] | null)[] = []
  const watcher = watching(new RootWatcher((paths) => { got.push(paths) }, 20, 200), ["/r"])
  try {
    watcher.carryOver(["/r/cancelled.txt"])
    await Bun.sleep(60)
    // Not on its own: a run stopped on purpose does not start again at once.
    expect(got).toEqual([])
    notify(watcher, "/r/next.txt")
    await Bun.sleep(80)
    expect(got[0]!.sort()).toEqual(["/r/cancelled.txt", "/r/next.txt"])
    // An unfinished walk of every root makes the next refresh one too.
    watcher.carryOver(null)
    notify(watcher, "/r/later.txt")
    await Bun.sleep(80)
    expect(got[1]).toBeNull()
  } finally { watcher.close() }
})

test("native events name the files that changed", async () => {
  const root = realpathSync(mkdtempSync(join(process.env.ZSEARCH_TEST_TMP || tmpdir(), "zsearch-watch-")))
  const got: string[] = []
  const watcher = new RootWatcher((paths) => { got.push(...(paths ?? ["*"])) }, 50, 500)
  try {
    watcher.update({ ...defaultConfig(), roots: [root], liveUpdates: true })
    await Bun.sleep(200)
    writeFileSync(join(root, "created.txt"), "hello\n")
    for (let i = 0; i < 50 && !got.length; i++) await Bun.sleep(100)
    expect(got).toContain(join(root, "created.txt"))
  } finally { watcher.close(); rmSync(root, { recursive: true, force: true }) }
})
