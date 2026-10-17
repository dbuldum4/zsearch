import { expect, test } from "bun:test"
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig } from "../src/config.ts"
import { openDb } from "../src/index/db.ts"
import { DEFAULT_EXTRACT, extract, wantsContent } from "../src/index/extract/index.ts"
import { extractMobi } from "../src/index/extract/mobi.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { mobi } from "./helpers/mobi.ts"
import { FIXTURES } from "./helpers/corpus.ts"

const bytes = (s: string) => new TextEncoder().encode(s)

test("MOBI: HTML text in record order, UTF-8 across records, scripts and styles omitted", () => {
  const html = bytes('<html><body><h1>Harbor</h1><p>The keeper’s cat.</p><script>hidden</script><style>p{}</style></body></html>')
  const cut = html.indexOf(0xe2) + 1
  expect(extractMobi(mobi([html.slice(0, cut), html.slice(cut)]))).toBe("Harbor\n\nThe keeper’s cat.")
})

test("MOBI: PalmDOC literals, space pairs and overlapping back references", () => {
  // abc + a distance-three, length-six reference + space/x + a literal high byte.
  const data = new Uint8Array([97, 98, 99, 0x80, 0x1b, 0xf8, 1, 0xe9])
  expect(extractMobi(mobi([data], { compression: 2, encoding: 1252, textLength: 12 }))).toBe("abcabcabc xé")
})

test("MOBI: explicit page breaks keep chapter boundaries", () => {
  expect(extractMobi(mobi([bytes("<p>One</p><mbp:pagebreak/><p>Two</p>")]))).toBe("One\fTwo")
})

test("MOBI: trailing metadata and UTF-8 overlap are removed before decompressing", () => {
  const text = bytes("<p>Café</p>")
  const record = new Uint8Array([...text, 0xc3, 1, 65, 66, 0x83])
  expect(extractMobi(mobi([record], { flags: 3, textLength: text.length }))).toBe("Café")
  // Backwards variable-width size 130, including its two size bytes.
  const large = new Uint8Array([...text, ...new Uint8Array(128), 0x81, 2])
  expect(extractMobi(mobi([large], { flags: 2, textLength: text.length }))).toBe("Café")
})

test("MOBI: rejects encrypted and unsupported books explicitly", () => {
  for (const encryption of [1, 2]) expect(() => extractMobi(mobi([bytes("secret")], { encryption }))).toThrow("encrypted")
  expect(() => extractMobi(mobi([bytes("text")], { compression: 17480 }))).toThrow("HUFF/CDIC")
  expect(() => extractMobi(mobi([bytes("text")], { version: 8 }))).toThrow("KF8")
  expect(() => extractMobi(mobi([bytes("text")], { encoding: 42 }))).toThrow("encoding")
})

test("MOBI: malformed records, references, trailing data and expansion limits", () => {
  expect(() => extractMobi(new Uint8Array(77))).toThrow("not a MOBI")
  const badOffset = mobi([bytes("text")])
  new DataView(badOffset.buffer).setUint32(86, 1)
  expect(() => extractMobi(badOffset)).toThrow("offset")
  const badHeader = mobi([bytes("text")])
  const start = new DataView(badHeader.buffer).getUint32(78)
  new DataView(badHeader.buffer).setUint32(start + 20, 1000)
  expect(() => extractMobi(badHeader)).toThrow("header length")
  for (const data of [[3, 65], [0x80], [0x80, 8], [97, 0x80, 0]]) {
    expect(() => extractMobi(mobi([new Uint8Array(data)], { compression: 2 }))).toThrow()
  }
  expect(() => extractMobi(mobi([bytes("x")], { textLength: 2 }))).toThrow("truncated")
  expect(() => extractMobi(mobi([new Uint8Array([0xff])], { compression: 2, recordSize: 1 }))).toThrow("budget")
  expect(() => extractMobi(mobi([bytes("x")], { textLength: 33 << 20 }))).toThrow("budget")
  expect(() => extractMobi(mobi([new Uint8Array([0xff])], { flags: 2 }))).toThrow("trailing")
  expect(() => extractMobi(mobi([new Uint8Array([3])], { flags: 1 }))).toThrow("overlap")
})

test("ebooks: extraction budgets, incremental indexing, content search and highlighted previews", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zsearch-mobi-"))
  const db = openDb(join(dir, "index.db"))
  try {
    const path = join(dir, "book.mobi")
    writeFileSync(path, mobi([bytes("<h1>Lighthouse</h1><p>The keeper’s cat.</p>")]))
    const epubPath = join(dir, "book.epub")
    copyFileSync(join(FIXTURES, "docs/book.epub"), epubPath)
    const size = statSync(path).size
    expect(wantsContent("mobi", "ebook")).toBe(true)
    expect(await extract(path, size, "mobi", "ebook", { ...DEFAULT_EXTRACT, maxChars: 5 })).toEqual({ status: "ok", text: "Light", truncated: true })
    expect(await extract(path, size, "mobi", "ebook", { ...DEFAULT_EXTRACT, maxDocBytes: 1 })).toEqual({ status: "skip", reason: "too-large" })
    const config = { ...defaultConfig(), roots: [dir] }
    // Simulate a names-only catalog from before MOBI content support was available.
    await new Indexer(db, { ...config, content: { ...config.content, enabled: false } }, { inProcess: true }).run()
    await new Indexer(db, config, { inProcess: true }).run()
    const engine = new SearchEngine(db, config)
    const result = await engine.search("keeper", "find")
    const hit = result.hits.find((h) => h.path === path)!
    expect(hit).toBeDefined()
    const preview = engine.preview(hit.id, "keeper", "find")
    expect(preview.kind).toBe("ebook")
    expect(preview.source).toBe("index")
    expect(preview.message).toBeUndefined()
    expect(preview.lines.find((l) => l.n === preview.focusLine)?.ranges).toEqual([[4, 10]])
    const epub = result.hits.find((h) => h.path === epubPath)!
    expect(epub).toBeDefined()
    const epubPreview = engine.preview(epub.id, "keeper", "find")
    expect(epubPreview.kind).toBe("ebook")
    expect(epubPreview.source).toBe("index")
    expect(epubPreview.lines.some((l) => l.ranges.length > 0 && l.text.includes("keeper"))).toBe(true)
    // The same book remains discoverable when content reading is disabled, without a preview.
    const privateConfig = { ...config, content: { ...config.content, enabled: false } }
    expect(new SearchEngine(db, privateConfig).preview(hit.id, "keeper", "find").contentAllowed).toBe(false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
