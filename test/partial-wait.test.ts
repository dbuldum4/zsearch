import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig, saveConfig } from "../src/config.ts"
import { IndexRun } from "../src/index/client.ts"
import { getMeta, openDb, PARTIAL_RUN, setMeta } from "../src/index/db.ts"
import type { IndexProgress } from "../src/index/indexer.ts"
import { acquireLock } from "../src/index/lock.ts"

const MAIN = join(import.meta.dir, "..", "src", "main.ts")
let dir: string, root: string
const previousHome = process.env.ZSEARCH_HOME
beforeAll(() => {
  dir = mkdtempSync(join(process.env.ZSEARCH_TEST_TMP || tmpdir(), "zsearch-partial-wait-"))
  root = join(dir, "files")
  mkdirSync(root)
  writeFileSync(join(root, "a.txt"), "alpha\n")
  writeFileSync(join(root, "b.txt"), "beta\n")
  process.env.ZSEARCH_HOME = join(dir, "data")
  saveConfig({ ...defaultConfig(), roots: [root], semantic: { ...defaultConfig().semantic, enabled: false } })
})
afterAll(() => {
  if (previousHome === undefined) delete process.env.ZSEARCH_HOME
  else process.env.ZSEARCH_HOME = previousHome
  rmSync(dir, { recursive: true, force: true })
})

/** Hold the index lock as a run of the given kind would. */
function hold(dbPath: string, lockPath: string, partial: boolean) {
  const release = acquireLock(lockPath)
  if (!release) throw new Error("lock taken")
  const db = openDb(dbPath)
  setMeta(db, PARTIAL_RUN, partial ? "1" : "")
  db.close()
  return release
}

test("a run asked for waits for a refresh of changed paths to let go of the lock, and only for one", async () => {
  const dbPath = join(dir, "worker.db"), lockPath = join(dir, "worker.lock")
  const config = { ...defaultConfig(), roots: [root], semantic: { ...defaultConfig().semantic, enabled: false } }
  let release = hold(dbPath, lockPath, true)
  const seen: IndexProgress[] = []
  let ended = false
  const run = new IndexRun(config, dbPath, lockPath, { onProgress: (p) => seen.push(p) })
  void run.done.then(() => { ended = true })
  for (let i = 0; i < 100 && !seen.length; i++) await Bun.sleep(50)
  expect(seen[0]?.phase).toBe("starting")
  await Bun.sleep(300)
  expect(ended).toBe(false)
  release()
  const outcome = await run.done
  expect(outcome.status).toBe("done")
  if (outcome.status === "done") expect(outcome.progress.scanned).toBe(2)
  const db = openDb(dbPath, { readonly: true })
  expect(getMeta(db, PARTIAL_RUN)).toBe("")
  db.close()

  // A run that started on its own does not wait, nor does any run for a full one holding the lock.
  release = hold(dbPath, lockPath, true)
  expect((await new IndexRun(config, dbPath, lockPath, {}, false, true).done).status).toBe("locked")
  release()
  release = hold(dbPath, lockPath, false)
  expect((await new IndexRun(config, dbPath, lockPath).done).status).toBe("locked")
  release()
}, 30_000)

test("zsearch index waits for a refresh of changed paths, then walks every folder", async () => {
  const data = join(dir, "data")
  const release = hold(join(data, "index.db"), join(data, "index.lock"), true)
  const proc = Bun.spawn(["bun", MAIN, "index"], {
    cwd: dir,
    env: { ...process.env, HOME: dir, ZSEARCH_HOME: data },
    stdout: "ignore",
    stderr: "pipe",
  })
  let err = ""
  const drain = (async () => {
    const decoder = new TextDecoder()
    for (const reader = proc.stderr.getReader(); ;) {
      const { value, done } = await reader.read()
      if (done) break
      err += decoder.decode(value, { stream: true })
    }
  })()
  // The child announces it is waiting before the lock is let go, however long its startup takes.
  const deadline = Date.now() + 20_000
  while (!err.includes("Waiting for the update of changed files to finish") && Date.now() < deadline) await Bun.sleep(20)
  expect(err).toContain("Waiting for the update of changed files to finish")
  release()
  expect(await proc.exited).toBe(0)
  await drain
  expect(err).toContain("2 items scanned")
}, 30_000)
