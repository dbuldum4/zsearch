import { afterAll, beforeAll, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { join } from "node:path"
import { defaultConfig } from "../src/config.ts"
import { App } from "../src/tui/app.tsx"
import { makeCorpus } from "./helpers/corpus.ts"
import { testServices } from "./helpers/services.ts"

let corpus: ReturnType<typeof makeCorpus>
const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME }
beforeAll(() => {
  corpus = makeCorpus()
  process.env.HOME = corpus.home
  process.env.ZSEARCH_HOME = join(corpus.home, ".zsearch-data")
})
afterAll(() => {
  corpus.cleanup()
  process.env.HOME = env.HOME
  if (env.ZSEARCH_HOME === undefined) delete process.env.ZSEARCH_HOME
  else process.env.ZSEARCH_HOME = env.ZSEARCH_HOME
})

for (const [w, h] of [
  [40, 10],
  [60, 14],
  [200, 60],
]) {
  test(`renders at ${w}x${h} (setup and search)`, async () => {
    const t = testServices(defaultConfig(), { firstRun: true })
    const s = await testRender(() => <App services={t.services} initialQuery="budget" />, { width: w!, height: h! })
    try {
      await s.renderOnce()
      expect(s.captureCharFrame()).toContain("zsearch")
      s.mockInput.pressKey("s")
      for (let i = 0; i < 100; i++) {
        await Bun.sleep(30)
        await s.renderOnce()
        if (s.captureCharFrame().includes("budget.xlsx")) break
      }
      const frame = s.captureCharFrame()
      expect(frame).toContain("budget.xlsx")
      // every line fits the terminal width
      for (const line of frame.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(w!)
      s.mockInput.pressKey("F1")
      await s.renderOnce()
      await Bun.sleep(30)
      await s.renderOnce()
    } finally {
      s.renderer.destroy()
      t.close()
    }
  })
}
