import { afterAll, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { defaultConfig } from "../src/config.ts"
import { openDb } from "../src/index/db.ts"
import { DEFAULT_EXTRACT, extract } from "../src/index/extract/index.ts"
import { Indexer } from "../src/index/indexer.ts"
import { extOf, kindOf } from "../src/kinds.ts"
import { SearchEngine } from "../src/search/engine.ts"
import { FIXTURES } from "./helpers/corpus.ts"

const dir = mkdtempSync(join(tmpdir(), "zsearch-more-formats-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const calendar = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Observatory telescope review\r\nDESCRIPTION:Budget approved\\nBring blue note\r\n book\\, receipts and pens\\; pencils.\r\nLOCATION:Zanzibar hall\r\nDTSTART:20261020T090000Z\r\nATTENDEE;CN=\"Alex: Doe\":mailto:alex@example.test\r\nATTACH;ENCODING=BASE64;VALUE=BINARY:ATTACHMENTNOISE\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
const contact = "BEGIN:VCARD\nVERSION:4.0\nFN:Zoë Müller\nitem1.EMAIL:zoe@example.test\nORG:Zanzibarcontact Observatory\nNOTE:Works on tele\n scopes\\nCall on Thursday\nPHOTO:data:image/jpeg;base64,PHOTONOISE\nKEY:PRIVATEKEYNOISE\nEND:VCARD\n"
const write = (name: string, text: string) => { const path = join(dir, name); writeFileSync(path, text); return path }
const read = (path: string, opts = DEFAULT_EXTRACT) => extract(path, statSync(path).size, extOf(basename(path)), kindOf(basename(path)), opts)

test("calendar and contact fields unfold, decode text escapes and omit embedded data", async () => {
  const cal = await read(write("meeting.ics", calendar))
  expect(cal.status).toBe("ok")
  if (cal.status === "ok") {
    expect(cal.text).toContain("Bring blue notebook, receipts and pens; pencils.")
    expect(cal.text).toContain("mailto:alex@example.test")
    expect(cal.text).not.toContain("ATTACHMENTNOISE")
  }
  const card = await read(write("person.vcf", contact))
  expect(card.status).toBe("ok")
  if (card.status === "ok") {
    expect(card.text).toContain("Zoë Müller")
    expect(card.text).toContain("Works on telescopes\nCall on Thursday")
    expect(card.text).not.toContain("PHOTONOISE")
    expect(card.text).not.toContain("PRIVATEKEYNOISE")
  }
  expect(await read(write("not-a-card.vcf", "FN:unrelated file"))).toEqual({ status: "skip", reason: "empty" })
  const legacy = await read(write("old.vcf", "BEGIN:VCARD\nVERSION:2.1\nNOTE;ENCODING=QUOTED-PRINTABLE:encoded=20text\nEND:VCARD\n"))
  expect(legacy).toEqual({ status: "skip", reason: "empty" })
})

test("text export size and output limits are enforced", async () => {
  const path = write("limits.ics", calendar)
  expect(await read(path, { ...DEFAULT_EXTRACT, maxTextBytes: 16 })).toEqual({ status: "skip", reason: "too-large" })
  expect(await read(path, { ...DEFAULT_EXTRACT, maxChars: 20 })).toMatchObject({ status: "ok", truncated: true, text: expect.any(String) })
})

test("Office templates and slideshows reuse their format's existing document parser", async () => {
  const examples = [
    ["dot", "poi/SampleDoc.doc", "I am a test document"],
    ["xlt", "docs/legacy.xls", "Lodging in Zürich"],
    ["pot", "poi/basic_test_ppt_file.ppt", "test title"],
    ["pps", "poi/basic_test_ppt_file.ppt", "test title"],
    ["dotm", "docs/report.docx", "Quarterly Planning Report"],
    ["xltm", "docs/budget.xlsx", "Marketing"],
    ["potm", "docs/deck.pptx", "Downlink rate"],
  ]
  for (const [ext, source, expected] of examples) {
    const path = join(dir, `example.${ext}`)
    copyFileSync(join(FIXTURES, source!), path)
    const r = await read(path)
    expect(r.status).toBe("ok")
    if (r.status === "ok") expect(r.text).toContain(expected!)
  }
})

test("calendar/contact contents are indexed and become searchable on an ordinary update", async () => {
  const root = join(dir, "exports"); mkdirSync(root)
  writeFileSync(join(root, "meeting.ics"), calendar)
  writeFileSync(join(root, "person.vcf"), contact)
  const db = openDb(join(dir, "index.db")), config = { ...defaultConfig(), roots: [root], indexLoad: 100 }
  try {
    const p = await new Indexer(db, config, { inProcess: true }).run()
    expect(p.contentErrors).toBe(0)
    const engine = new SearchEngine(db, config)
    expect((await engine.search("blue notebook")).hits.map((h) => basename(h.path))).toEqual(["meeting.ics"])
    expect((await engine.search("zanzibarcontact")).hits.map((h) => basename(h.path))).toEqual(["person.vcf"])
    expect((await engine.search("PHOTONOISE")).hits).toEqual([])
  } finally { db.close() }
})
