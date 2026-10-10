import { describe, expect, test } from "bun:test"
import { CpuBudget, defaultWorkers, loadShare } from "../src/index/load.ts"

describe("how much of the computer indexing uses", () => {
  test("the setting is a share between a tenth and the whole", () => {
    expect(loadShare(70)).toBe(0.7)
    expect(loadShare(100)).toBe(1)
    expect(loadShare(250)).toBe(1)
    expect(loadShare(0)).toBe(0.1)
    expect(loadShare(Number.NaN)).toBe(1)
  })

  test("extraction workers: the cores less two, at most 8, within the share", () => {
    expect([2, 4, 8, 10, 12, 16].map((c) => defaultWorkers(1, c))).toEqual([1, 2, 6, 8, 8, 8])
    expect([2, 4, 8, 10, 12, 16].map((c) => defaultWorkers(0.7, c))).toEqual([1, 2, 5, 6, 7, 8])
    expect(defaultWorkers(0.1, 16)).toBe(1)
  })

  test("the CPU budget says when this process took more than its share", async () => {
    const all = new CpuBudget(1, 4)
    const little = new CpuBudget(0.1, 1)
    expect(little.over).toBe(false)
    // Busy for half a second: a whole core against a tenth of one.
    const end = performance.now() + 500
    let allOver = false
    while (performance.now() < end) {
      allOver ||= all.over
      little.over
    }
    expect(allOver).toBe(false)
    expect(little.over).toBe(true)
    expect(all.over).toBe(false)
    // Idle, the last second's share falls back under the limit.
    await Bun.sleep(1200)
    little.over
    await Bun.sleep(300)
    expect(little.over).toBe(false)
  })

  test("the disk priority can be lowered where the system has the setting", async () => {
    // On a thread of its own: the test runner's thread keeps its priority.
    const code = `import { backgroundDisk } from ${JSON.stringify(new URL("../src/index/load.ts", import.meta.url).href)}; postMessage(backgroundDisk())`
    const w = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })))
    const ok = await new Promise((r) => (w.onmessage = (ev) => r(ev.data)))
    w.terminate()
    const supported = process.platform === "darwin" || (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64"))
    expect(ok).toBe(supported)
  })
})
