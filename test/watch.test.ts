import { expect, test } from "bun:test"
import { RootWatcher } from "../src/index/watch.ts"

// Exercise event coalescing without depending on platform watcher delivery.
function notify(watcher: RootWatcher) {
  (watcher as unknown as { schedule(): void }).schedule()
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
