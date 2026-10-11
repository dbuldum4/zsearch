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

  test("the CPU budget says when this process took more than its share", () => {
    let at = 0, cpu = 0
    const sample = () => ({ at, cpu })
    const all = new CpuBudget(1, 4, sample), little = new CpuBudget(0.1, 1, sample)
    expect(little.over).toBe(false)
    for (let i = 0; i < 10; i++) { at += 50000; cpu += 50000; little.over }
    expect(all.over).toBe(false)
    expect(little.over).toBe(true)
    for (let i = 0; i < 30; i++) { at += 50000; little.over }
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
