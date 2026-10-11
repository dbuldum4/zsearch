import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb } from "../src/index/db.ts"
import { DEFAULT_EXTRACT, extract, wantsContent } from "../src/index/extract/index.ts"
import { Indexer } from "../src/index/indexer.ts"
import { ocrToolPath } from "../src/platform.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { FIXTURES, homeConfig, makeCorpus } from "./helpers/corpus.ts"

// The real helper uses macOS's Vision framework (macos/Sources/ZSearchOCR). These tests stand in
// a script that prints fixed text, to check what the engine does with it on any system.
let dir: string
let fake: string
let failing: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zsearch-ocr-"))
  fake = join(dir, "zsearch-ocr")
  writeFileSync(
    fake,
    `#!/bin/sh
case "$1" in
  image) echo "Receipt total 42.00 from $(basename "$2")" ;;
  pdf) printf 'scanned first page\\f(PDFKit text, not used)\\f\\fread by ocr' ;;
  *) exit 2 ;;
esac
`,
  )
  chmodSync(fake, 0o755)
  failing = join(dir, "broken-ocr")
  writeFileSync(failing, "#!/bin/sh\necho 'no Vision here' >&2\nexit 1\n")
  chmodSync(failing, 0o755)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("OCR", () => {
  test("images are read only with an OCR helper", async () => {
    const img = join(dir, "scan.png")
    writeFileSync(img, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))
    const size = statSync(img).size
    expect(wantsContent("png", "image")).toBe(false)
    expect(wantsContent("png", "image", true)).toBe(true)
    expect(wantsContent("mp3", "audio", true)).toBe(false)
    expect(await extract(img, size, "png", "image")).toEqual({ status: "skip", reason: "unsupported" })
    expect(await extract(img, size, "png", "image", { ...DEFAULT_EXTRACT, ocrTool: fake })).toEqual({ status: "ok", text: "Receipt total 42.00 from scan.png", truncated: false })
  })

  test("pages of a PDF without text are filled in by OCR, the others keep their text", async () => {
    const pdf = join(FIXTURES, "pages/blank-pages.pdf")
    const r = await extract(pdf, statSync(pdf).size, "pdf", "pdf", { ...DEFAULT_EXTRACT, ocrTool: fake })
    expect(r.status === "ok" && r.text.split("\f")).toEqual(["scanned first page", "Calvin cycle on the second page", "", "Krebs cycle on the fourth page"])
  })

  test("a failing helper leaves the PDF's own text", async () => {
    const pdf = join(FIXTURES, "pages/blank-pages.pdf")
    const r = await extract(pdf, statSync(pdf).size, "pdf", "pdf", { ...DEFAULT_EXTRACT, ocrTool: failing })
    expect(r.status === "ok" && r.text.split("\f")).toEqual(["", "Calvin cycle on the second page", "", "Krebs cycle on the fourth page"])
  })

  test("ZSEARCH_OCR names the helper, and 0 turns it off", () => {
    const before = process.env.ZSEARCH_OCR
    try {
      process.env.ZSEARCH_OCR = fake
      expect(ocrToolPath()).toBe(fake)
      process.env.ZSEARCH_OCR = "0"
      expect(ocrToolPath()).toBeNull()
      process.env.ZSEARCH_OCR = join(dir, "missing")
      expect(ocrToolPath()).toBeNull()
    } finally {
      if (before === undefined) delete process.env.ZSEARCH_OCR
      else process.env.ZSEARCH_OCR = before
    }
  })
})

describe("indexing with OCR", () => {
  let corpus: ReturnType<typeof makeCorpus>
  const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME, ZSEARCH_OCR: process.env.ZSEARCH_OCR }
  beforeAll(() => {
    corpus = makeCorpus()
    process.env.HOME = corpus.home
    process.env.ZSEARCH_HOME = join(corpus.home, ".zsearch-data")
  })
  afterAll(() => {
    corpus.cleanup()
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test("images get their text when OCR is on, and lose it when it is turned off", async () => {
    const file = join(corpus.home, ".zsearch-data", "index.db")
    const db = openDb(file)
    const engine = new SearchEngine(openDb(file), homeConfig())
    const found = async () => (await engine.search("receipt total", "find")).hits.map((h) => h.display)

    process.env.ZSEARCH_OCR = "0"
    await new Indexer(db, homeConfig(), { inProcess: true }).run()
    expect(await found()).toEqual([])

    process.env.ZSEARCH_OCR = fake
    await new Indexer(db, homeConfig(), { inProcess: true }).run()
    expect(await found()).toEqual(["Pictures/holiday-beach.jpg"])

    const off = homeConfig()
    off.content.ocr = false
    await new Indexer(db, off, { inProcess: true }).run()
    expect(await found()).toEqual([])
    db.close()
  })
})

// On macOS CI, with the real helper built: ZSEARCH_OCR_TEST=path/to/zsearch-ocr.
const real = process.env.ZSEARCH_OCR_TEST
describe.skipIf(!real)("the real OCR helper", () => {
  test("reads an image", async () => {
    const img = join(FIXTURES, "ocr/receipt.png")
    const r = await extract(img, statSync(img).size, "png", "image", { ...DEFAULT_EXTRACT, ocrTool: real })
    expect(r.status === "ok" && r.text).toMatch(/Harbour Cafe[\s\S]*42\.50/)
  })

  test("reads the pages of a scanned PDF, in order", async () => {
    const pdf = join(FIXTURES, "ocr/scanned.pdf")
    const r = await extract(pdf, statSync(pdf).size, "pdf", "pdf", { ...DEFAULT_EXTRACT, ocrTool: real })
    const pages = r.status === "ok" ? r.text.split("\f") : []
    expect(pages.length).toBe(2)
    expect(pages[0]).toMatch(/boiler/)
    expect(pages[1]).toMatch(/zeppelin/)
  })
})
