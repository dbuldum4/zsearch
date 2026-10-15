import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { deflateRawSync } from "node:zlib"
import { defaultConfig } from "../src/config.ts"
import { openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { duplicateFiles } from "../src/search/duplicates.ts"
import { RootWatcher } from "../src/index/watch.ts"
import { ZipReader } from "../src/index/extract/zip.ts"
import { ExtractPool } from "../src/index/pool.ts"
import { extract, DEFAULT_EXTRACT } from "../src/index/extract/index.ts"
import { FIXTURES } from "./helpers/corpus.ts"

async function corpus(run: (e: SearchEngine, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "zsearch-features-")), docs = join(root, "docs")
  mkdirSync(docs)
  const files = { "a.txt": "alpha café budget report", "b.md": "beta report\nalpha is also here", "IMG_1234.jpg": "", "c.txt": "gamma budget", "copy.txt": "gamma budget", "accent.txt": "café Café cafe cafeteria", "long.txt": Array.from({ length: 100 }, (_, i) => i === 50 ? "needle" : `line ${i}`).join("\n") }
  for (const [name, text] of Object.entries(files)) { const path = join(docs, name); writeFileSync(path, text); utimesSync(path, new Date(), new Date(1_000_000 + text.length * 1000)) }
  const config = { ...defaultConfig(), roots: [docs], indexLoad: 100 }, db = openDb(join(root, "index.db"))
  try { await new Indexer(db, config, { inProcess: true }).run(); await run(new SearchEngine(db, config), docs) }
  finally { db.close(); rmSync(root, { recursive: true, force: true }) }
}

test("name globs, name-only regex and all supported sort keys", async () => corpus(async (e) => {
  expect((await e.search("IMG_????.jpg")).hits.map((h) => h.display)).toHaveLength(1)
  expect((await e.search("*.txt")).hits).toHaveLength(5)
  expect((await e.search("name:/^[ab]\\./i")).hits).toHaveLength(2)
  // A g or y flag must not make a reused regex skip names.
  for (let i = 0; i < 3; i++) expect((await e.search("name:/^[ab]\\./gi")).hits).toHaveLength(2)
  expect((await e.search("name:alpha")).hits).toHaveLength(0)
  expect((await e.search("name:*.txt sort:-size", "find", { limit: 1 })).hits[0]?.path.endsWith("long.txt")).toBe(true)
  const paths = (await e.search("*.txt sort:name")).hits.map((h) => h.path)
  expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)))
  expect((await e.search("*.txt sort:path")).hits.map((h) => h.path)).toEqual(paths)
  expect((await e.search("*.txt sort:date", "find", { limit: 1 })).hits[0]?.path.endsWith("c.txt")).toBe(true)
}))

test("OR, grouped queries, all words, proximity and explicit match controls", async () => corpus(async (e) => {
  expect((await e.search("alpha OR gamma")).hits).toHaveLength(4)
  expect((await e.search("(alpha OR beta) report")).hits).toHaveLength(2)
  expect((await e.search("all:alpha report")).hits).toHaveLength(2)
  expect((await e.search("alpha report near:2")).hits).toHaveLength(1)
  expect((await e.search("alpha NEAR/2 report")).hits).toHaveLength(1)
  expect((await e.search("alpha report near:0")).hits).toHaveLength(0)
  expect((await e.search("Café case:on")).hits).toHaveLength(1)
  expect((await e.search("CAFE case:off diacritics:off word:on")).hits).toHaveLength(2)
  expect((await e.search("cafe diacritics:on word:on")).hits).toHaveLength(1)
  expect((await e.search("/alpha.*report/i")).hits).toHaveLength(1)
  expect((await e.search("/alpha .* report/i")).hits).toHaveLength(1)
}))

test("duplicates compare hashes and obey names-only policy", async () => corpus(async (e, root) => {
  const found = await duplicateFiles(e.db, e.config)
  expect(found.groups).toHaveLength(1)
  expect(found.groups[0]?.paths.map((p) => p.slice(p.lastIndexOf("/") + 1)).sort()).toEqual(["c.txt", "copy.txt"])
  e.config.namesOnly = [join(root, "copy.txt")]
  expect((await duplicateFiles(e.db, e.config)).groups).toHaveLength(0)
}))

test("creation dates, tags and folded previews", async () => corpus(async (e) => {
  const row = e.db.query("SELECT id FROM files WHERE name = 'long.txt'").get() as { id: number }
  e.db.query("UPDATE files SET metadata = ?, created = ? WHERE id = ?").run(JSON.stringify({ tags: "Urgent\nResearch" }), new Date(2024, 4, 1).getTime(), row.id)
  e.refresh(true)
  e.config.content.metadata = true
  expect((await e.search("tag:urgent created:2024")).hits).toHaveLength(1)
  expect((await e.search("tag:urgent -created:2024")).hits).toHaveLength(0)
  e.config.namesOnly = [e.catalog.paths[e.catalog.indexOf(row.id)!]!]
  expect((await e.search("tag:urgent")).hits).toHaveLength(0)
  e.config.namesOnly = []
  // Tags changed by an index update are read again, not served from before.
  e.db.query("UPDATE files SET metadata = ? WHERE id = ?").run(JSON.stringify({ tags: "Research" }), row.id)
  e.refresh(true)
  expect((await e.search("tag:urgent")).hits).toHaveLength(0)
  expect((await e.search("tag:research")).hits).toHaveLength(1)
  const folded = e.preview(row.id, "needle fold:on", "find")
  expect(folded.totalLines).toBe(100)
  expect(folded.lines.map((l) => l.n)).toEqual([49, 50, 51, 52, 53])
}))

test("native changes are debounced and retried while an index is busy", async () => corpus(async (e, root) => {
  // Native watcher registration can finish after update() returns on macOS, so keep
  // writing (slower than the debounce) until the first event arrives. Then stop and let
  // late events settle: after the busy call, the only thing that can call back is the retry.
  let phase: "warmup" | "settle" | "busy" | "retry" = "warmup"
  let warmed!: () => void, retried!: () => void
  const ready = new Promise<void>((r) => { warmed = r }), done = new Promise<void>((r) => { retried = r })
  const watcher = new RootWatcher(() => {
    if (phase === "warmup") { phase = "settle"; warmed() }
    else if (phase === "busy") { phase = "retry"; return false }
    else if (phase === "retry") retried()
  }, 100)
  const within = (promise: Promise<void>, ms: number, message: () => string) => {
    let timer!: ReturnType<typeof setTimeout>
    const expired = new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(message())), ms) })
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
  }
  let changes = 0
  const write = () => writeFileSync(join(root, `new-${++changes}.txt`), "newly created")
  watcher.update(e.config)
  const signal = setInterval(write, 250)
  try {
    write()
    await within(ready, 10_000, () => `No native watcher notification for ${root}`)
    clearInterval(signal)
    await Bun.sleep(500)
    phase = "busy"
    write()
    await within(done, 3_000, () => phase === "busy" ? "No notification for the busy change" : "The busy change was not retried")
  } finally { clearInterval(signal); watcher.close() }
}))

function zip(parts: { name: string; text: Uint8Array; declared?: number }[]): Uint8Array {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0
  for (const part of parts) {
    const name = Buffer.from(part.name), data = deflateRawSync(part.text), header = Buffer.alloc(30), directory = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(8, 8); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(part.declared ?? part.text.length, 22); header.writeUInt16LE(name.length, 26)
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(part.declared ?? part.text.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42)
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length
  }
  const tail = Buffer.alloc(22); tail.writeUInt32LE(0x06054b50); tail.writeUInt16LE(parts.length, 10); tail.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, tail])
}

test("ZIP budgets bound total inflation, forged sizes and entry counts", () => {
  const text = new Uint8Array(12 * 1024 * 1024)
  const z = new ZipReader(zip([0, 1, 2].map((i) => ({ name: String(i), text }))))
  expect(z.read("0")?.length).toBe(text.length); expect(z.read("1")?.length).toBe(text.length)
  expect(() => z.read("2")).toThrow("inflate budget")
  expect(() => new ZipReader(zip([{ name: "bomb", text: new Uint8Array(17 * 1024 * 1024), declared: 1 }])).read("bomb")).toThrow()
  expect(() => new ZipReader(zip(Array.from({ length: 2049 }, (_, i) => ({ name: String(i), text: new Uint8Array() }))))).toThrow("too many parts")
})

test("unsupported iWork files are skipped and PDF metadata is optional", async () => {
  const root = mkdtempSync(join(tmpdir(), "zsearch-formats-"))
  try {
    const path = join(root, "unsupported.pages"); writeFileSync(path, "unsupported")
    expect(await extract(path, 11, "pages", "doc")).toEqual({ status: "skip", reason: "empty" })
    const pdf = join(FIXTURES, "docs/paper.pdf")
    const iwork = join(root, "preview.pages")
    writeFileSync(iwork, zip([{ name: "QuickLook/Preview.pdf", text: readFileSync(pdf) }]))
    const embedded = await extract(iwork, 1, "pages", "doc")
    expect(embedded.status).toBe("ok")
    if (embedded.status === "ok") expect(embedded.text).toContain("Calvin")
    const result = await extract(pdf, 1, "pdf", "pdf", { ...DEFAULT_EXTRACT, metadata: true })
    expect(result.status).toBe("ok")
    if (result.status === "ok") expect(result.text).toContain("Title:")
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test("malformed spreadsheet elements do not rescan the XML", async () => {
  const { extractXlsx } = await import("../src/index/extract/office.ts")
  const encode = (text: string) => new TextEncoder().encode(text)
  const archive = zip([
    { name: "xl/workbook.xml", text: encode("<workbook/>") },
    { name: "xl/sharedStrings.xml", text: encode("<si>".repeat(40000)) },
    { name: "xl/worksheets/sheet1.xml", text: encode("<row>".repeat(40000)) },
  ])
  const started = performance.now()
  expect(extractXlsx(archive)).toBe("sheet1")
  expect(performance.now() - started).toBeLessThan(1000)
})

test("OCR preserves completed pages when a helper is terminated", async () => {
  const { ocrBlankPages, ocrImage } = await import("../src/index/extract/ocr.ts")
  const root = mkdtempSync(join(tmpdir(), "zsearch-partial-ocr-"))
  try {
    const helper = join(root, "helper")
    writeFileSync(helper, `#!${process.execPath}\nawait Bun.write(Bun.stdout, "scanned first page\\f\\funfinished"); process.kill(process.pid, "SIGTERM")\n`, { mode: 0o700 })
    expect(await ocrBlankPages(helper, "unused.pdf", "\fexisting second page\f", 100)).toBe("scanned first page\fexisting second page")
    await expect(ocrImage(helper, "unused.png", 100)).rejects.toThrow("OCR timed out")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("pdf.js destroys the active document on its deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "zsearch-pdf-deadline-"))
  try {
    const probe = join(root, "probe.ts")
    const module = join(import.meta.dir, "../src/index/extract/pdf.ts")
    writeFileSync(probe, `import { mock } from "bun:test"
let destroyed = 0
mock.module(${JSON.stringify(import.meta.resolve("unpdf"))}, () => ({ getDocumentProxy: async () => ({ destroy: async () => { destroyed++ } }), extractText: () => new Promise(() => {}) }))
const { extractPdfBytes } = await import(${JSON.stringify(module)})
try { await extractPdfBytes(new Uint8Array(), 10); process.exit(1) } catch (e) { if (!String(e).includes("timed out") || !destroyed) { console.error(String(e), destroyed); process.exit(2) } }
`)
    const proc = Bun.spawn([process.execPath, probe], { stdout: "pipe", stderr: "pipe" })
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect({ code, err }).toEqual({ code: 0, err: "" })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("a negative Word piece-table length fails instead of looping", async () => {
  // Minimal compound file: directory, WordDocument, 0Table, then the FAT. The
  // property modifier's signed -3 length used to keep the CLX cursor at zero.
  const bytes = Buffer.alloc(5 * 512)
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(bytes)
  bytes.writeUInt16LE(9, 0x1e); bytes.writeUInt16LE(6, 0x20)
  bytes.writeUInt32LE(1, 0x2c); bytes.writeUInt32LE(0xfffffffe, 0x3c); bytes.writeUInt32LE(0xfffffffe, 0x44)
  for (let i = 0; i < 109; i++) bytes.writeUInt32LE(i === 0 ? 3 : 0xffffffff, 0x4c + i * 4)
  for (const [index, name] of ["WordDocument", "0Table"].entries()) {
    const at = 512 + index * 128
    const encoded = Buffer.from(name + "\0", "utf16le"); encoded.copy(bytes, at)
    bytes.writeUInt16LE(encoded.length, at + 0x40); bytes[at + 0x42] = 2
    bytes.writeUInt32LE(index + 1, at + 0x74); bytes.writeUInt32LE(512, at + 0x78)
  }
  const wd = 1024
  bytes.writeUInt16LE(0xa5ec, wd); bytes.writeUInt16LE(11, wd + 34); bytes.writeUInt32LE(1, wd + 48)
  bytes.writeUInt32LE(3, wd + 82 + 33 * 8 + 4)
  bytes[1536] = 1; bytes.writeInt16LE(-3, 1537)
  for (let i = 0; i < 128; i++) bytes.writeUInt32LE(i < 3 ? 0xfffffffe : i === 3 ? 0xfffffffd : 0xffffffff, 2048 + i * 4)
  const root = mkdtempSync(join(tmpdir(), "zsearch-corrupt-doc-"))
  const pool = new ExtractPool(1, { ...DEFAULT_EXTRACT, fileTimeoutMs: 1000 })
  try {
    const path = join(root, "loop.doc"); writeFileSync(path, bytes)
    const result = await pool.run({ run: "corrupt-doc", id: 1, path, size: bytes.length, ext: "doc", kind: "doc" })
    expect(result.status).toBe("error")
    if (result.status === "error") expect(result.error).toContain("corrupt piece table")
  } finally { pool.close(); rmSync(root, { recursive: true, force: true }) }
})
