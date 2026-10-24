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

  async function diskPriorityInWorker() {
    // A separate thread keeps the test runner's disk priority unchanged.
    const code = `import { backgroundDisk } from ${JSON.stringify(new URL("../src/index/load.ts", import.meta.url).href)}; postMessage(backgroundDisk())`
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
    const worker = new Worker(url)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<boolean>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("disk priority worker did not answer")), 10_000)
        worker.onmessage = (event) => resolve(event.data)
        worker.onerror = (event) => { event.preventDefault(); reject(new Error(event.message)) }
      })
    } finally {
      clearTimeout(timer)
      worker.terminate()
      URL.revokeObjectURL(url)
    }
  }

  test("lowering disk priority is best effort on the current machine", async () => {
    const ok = await diskPriorityInWorker()
    expect(typeof ok).toBe("boolean")
    const supported = process.platform === "darwin" || (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64"))
    if (!supported) expect(ok).toBe(false)
  })

  test.skipIf(process.env.ZSEARCH_TEST_DISK_PRIORITY !== "1")("lowers disk priority on a provisioned native runner", async () => {
    expect(await diskPriorityInWorker()).toBe(true)
  })

  for (const failure of ["unavailable", "denied"]) {
    test(`disk priority returns false when the platform operation is ${failure}`, async () => {
      // Isolate module mocks from every other test importing bun:ffi.
      const child = Bun.spawn([process.execPath, "-e", `
        import { mock } from "bun:test"
        const ffi = await import("bun:ffi")
        Object.defineProperty(process, "platform", { value: "darwin" })
        let closed = 0
        mock.module("bun:ffi", () => ({ ...ffi, dlopen() {
          if (${JSON.stringify(failure)} === "unavailable") throw new Error("library unavailable")
          return { symbols: { setiopolicy_np: () => -1 }, close() { closed++ } }
        } }))
        const { backgroundDisk } = await import(${JSON.stringify(new URL("../src/index/load.ts", import.meta.url).href)})
        console.log(JSON.stringify({ ok: backgroundDisk(), closed }))
      `], { stdout: "pipe", stderr: "pipe" })
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect({ code, err }).toEqual({ code: 0, err: "" })
      expect(JSON.parse(out)).toEqual({ ok: false, closed: failure === "denied" ? 1 : 0 })
    })
  }
})
