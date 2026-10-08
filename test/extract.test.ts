import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extract, wantsContent } from "../src/index/extract/index.ts"
import { binaryStrings, extractRtf } from "../src/index/extract/legacy.ts"
import { decodeText, extractEmail, looksBinary } from "../src/index/extract/text.ts"
import { decodeEntities, htmlText, xmlText } from "../src/index/extract/xml.ts"
import { ZipReader } from "../src/index/extract/zip.ts"
import { extOf, kindOf } from "../src/kinds.ts"
import { FIXTURES } from "./helpers/corpus.ts"

async function ext(rel: string) {
  const p = join(FIXTURES, rel)
  const name = rel.split("/").pop()!
  const r = await extract(p, statSync(p).size, extOf(name), kindOf(name))
  if (r.status !== "ok") throw new Error(`expected text from ${rel}, got ${JSON.stringify(r)}`)
  return r.text
}

describe("document extractors", () => {
  test("docx: body, tables, headers and footers", async () => {
    const t = await ext("docs/report.docx")
    expect(t).toContain("Quarterly Planning Report")
    expect(t).toContain("The marketing budget for the northern region increased by twelve percent.")
    expect(t).toContain("Revenue projections look strong for the café expansion.")
    expect(t).toContain("Region\tHeadcount\nNorthwind\t42")
    expect(t).toContain("Confidential header text")
    expect(t).toContain("Footer page marker")
  })

  test("xlsx: sheets separated by form feeds, shared strings, numbers and booleans", async () => {
    const t = await ext("docs/budget.xlsx")
    const sheets = t.split("\f")
    expect(sheets).toHaveLength(2)
    expect(sheets[0]).toStartWith("Budget 2024\nDepartment\tQ1\tQ2\tNotes")
    expect(sheets[0]).toContain("Marketing\t80000\t92000.5\tconference sponsorship")
    expect(sheets[1]).toContain("ZX-81\tFlux capacitor\tTRUE")
  })

  test("pptx: slides in order with speaker notes", async () => {
    const t = await ext("docs/deck.pptx")
    const slides = t.split("\f")
    expect(slides).toHaveLength(3)
    expect(slides[0]).toContain("Welcome to Orion")
    expect(slides[0]).toContain("Remember to thank the volunteers")
    expect(slides[1]).toContain("Downlink rate is 2 Mbps from the probe")
    expect(slides[2]).toContain("Ask about the budget")
  })

  test("pdf: text with page breaks", async () => {
    const t = await ext("docs/paper.pdf")
    const pages = t.split("\f")
    expect(pages).toHaveLength(2)
    expect(pages[0]).toContain("Photosynthesis converts light energy into chemical energy.")
    expect(pages[1]).toContain("Calvin cycle")
  })

  test("pdf: built-in reader works without pdftotext", async () => {
    process.env.ZSEARCH_NO_PDFTOTEXT = "1"
    try {
      const { extractPdf } = await import("../src/index/extract/pdf.ts")
      const p = join(FIXTURES, "docs/paper.pdf")
      const t = await extractPdf(p, async () => new Uint8Array(await Bun.file(p).arrayBuffer()))
      expect(t.split("\f")).toHaveLength(2)
      expect(t).toContain("Chlorophyll absorbs mostly blue and red wavelengths.")
    } finally {
      delete process.env.ZSEARCH_NO_PDFTOTEXT
    }
  })

  test("OpenDocument text, spreadsheet and presentation", async () => {
    expect(await ext("docs/notes.odt")).toBe("Garden journal\nPlanted tomatoes\tand basil  today.\nRain expected & wind.")
    expect(await ext("docs/sheet.ods")).toBe("Apples\t17")
    expect((await ext("docs/slides.odp")).split("\f")).toEqual(["First slide nebula", "Second slide quasar"])
  })

  test("epub: chapters in spine order, scripts and styles dropped", async () => {
    const t = await ext("docs/book.epub")
    expect(t.indexOf("Chapter One")).toBeLessThan(t.indexOf("Chapter Two"))
    expect(t).toContain("The lighthouse keeper’s cat.")
    expect(t).not.toContain("ignored")
    expect(t).not.toContain("p{}")
  })

  test("rtf: control words, hex escapes, unicode", async () => {
    const t = await ext("docs/letter.rtf")
    expect(t).toContain("We request funding for the observatory upgrade.")
    expect(t).toContain("Café meeting at noon—bring € receipts.")
    expect(t).not.toContain("Times New Roman")
    expect(t).not.toContain("Secret Title")
  })

  test("email: decoded headers, quoted-printable plain part, attachments skipped", async () => {
    const t = await ext("docs/mail.eml")
    expect(t).toContain("Subject: Project update ✅")
    expect(t).toContain("The deployment is scheduled for Friday. Café at 9.")
    expect(t).not.toContain("HTML version")
    expect(t).not.toContain("JVBERi0")
  })

  test("jupyter notebook cells", async () => {
    const t = await ext("docs/analysis.ipynb")
    expect(t).toContain("# Data exploration")
    expect(t).toContain("df = pd.read_csv('iris.csv')")
  })

  test("legacy binary Office: .doc, .xls, .ppt", async () => {
    const doc = await ext("poi/SampleDoc.doc")
    expect(doc).toContain("I am a test document")
    expect(doc).toContain("This is page two")
    const xls = await ext("docs/legacy.xls")
    expect(xls).toBe("Expenses\nTravel\t1234.5\nLodging in Zürich\t99")
    const xls2 = await ext("poi/SampleSS.xls")
    expect(xls2.split("\f")[0]).toContain("Test spreadsheet")
    const ppt = await ext("poi/basic_test_ppt_file.ppt")
    expect(ppt).toContain("This is a test title")
    expect(ppt).toContain("These are the notes for page 1")
  })
})

describe("plain text handling", () => {
  const dir = mkdtempSync(join(tmpdir(), "zsearch-ext-"))
  const write = (name: string, data: string | Uint8Array) => {
    const p = join(dir, name)
    writeFileSync(p, data)
    return p
  }

  test("binary detection", () => {
    expect(looksBinary(new Uint8Array([0x48, 0x69, 0x00, 0x01]))).toBe(true)
    expect(looksBinary(new TextEncoder().encode("plain text\nwith lines\t"))).toBe(false)
    expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe(false) // UTF-16 BOM
  })

  test("decoding: UTF-8, BOMs and Windows-1252 fallback", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe("hi")
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe("hi")
    expect(decodeText(new TextEncoder().encode("naïve café"))).toBe("naïve café")
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]))).toBe("café €")
  })

  test("text, code and unknown text files are read; binaries and media are skipped", async () => {
    const run = (name: string, data: string | Uint8Array) => {
      const p = write(name, data)
      return extract(p, statSync(p).size, extOf(name), kindOf(name))
    }
    expect(await run("a.py", "def f():\n    return 1\n")).toEqual({ status: "ok", text: "def f():\n    return 1\n", truncated: false })
    expect(await run("Makefile", "all:\n\techo hi\n")).toMatchObject({ status: "ok" })
    expect(await run("noext", "just some words")).toMatchObject({ status: "ok", text: "just some words" })
    expect(await run("blob", new Uint8Array(20000).fill(0))).toEqual({ status: "skip", reason: "binary" })
    expect(await run("photo.jpg", new Uint8Array([0xff, 0xd8]))).toEqual({ status: "skip", reason: "unsupported" })
    expect(await run("empty.txt", "")).toEqual({ status: "skip", reason: "empty" })
    expect(await run("crlf.txt", "a\r\nb\r\n")).toMatchObject({ text: "a\nb\n" })
  })

  test("size limits and truncation", async () => {
    const p = write("big.txt", "word ".repeat(1000))
    expect(await extract(p, statSync(p).size, "txt", "text", { maxTextBytes: 100, maxDocBytes: 100, maxChars: 100 })).toEqual({ status: "skip", reason: "too-large" })
    const r = await extract(p, statSync(p).size, "txt", "text", { maxTextBytes: 1e6, maxDocBytes: 1e6, maxChars: 50 })
    expect(r).toMatchObject({ status: "ok", truncated: true })
    if (r.status === "ok") expect(r.text).toHaveLength(50)
  })

  test("corrupt documents raise errors instead of crashing", async () => {
    const p = write("broken.docx", "this is not a zip file")
    await expect(extract(p, statSync(p).size, "docx", "doc")).rejects.toThrow(/not a valid Office file/)
    const z = write("nodoc.docx", new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]))
    await expect(extract(z, statSync(z).size, "docx", "doc")).rejects.toThrow(/word\/document.xml/)
  })

  test("disguised legacy files (RTF saved as .doc) are handled", async () => {
    const p = write("fake.doc", "{\\rtf1\\ansi Hello from a fake doc\\par}")
    expect(await extract(p, statSync(p).size, "doc", "doc")).toMatchObject({ status: "ok", text: "Hello from a fake doc" })
  })

  test("which files get content extraction", () => {
    expect(wantsContent("pdf", "pdf")).toBe(true)
    expect(wantsContent("ts", "code")).toBe(true)
    expect(wantsContent("", "other")).toBe(true)
    expect(wantsContent("png", "image")).toBe(false)
    expect(wantsContent("mp4", "video")).toBe(false)
  })

  test("cleanup", () => rmSync(dir, { recursive: true, force: true }))
})

describe("helpers", () => {
  test("XML entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#233; &#x20AC; &nbsp;x &bogus;")).toBe("a & b <c> é €  x &bogus;".replace(" ", " "))
  })

  test("xmlText respects text tags, skips and breaks", () => {
    const xml = "<r><t>Hello</t><x>ignored</x><p><t>World</t></p><t>A&amp;B</t></r>"
    expect(xmlText(xml, { textTags: new Set(["t"]), newlineAfter: new Set(["p"]) })).toBe("HelloWorld\nA&B")
  })

  test("htmlText keeps the title and visible text", () => {
    const t = htmlText("<html><head><title>My Page</title><script>evil()</script></head><body><h1>Head</h1><p>One&nbsp;two</p><table><tr><td>a</td><td>b</td></tr></table></body></html>")
    expect(t).toContain("My Page")
    expect(t).toContain("Head")
    expect(t).toContain("One two")
    expect(t).not.toContain("evil")
  })

  test("RTF unicode with \\uc0 and nested groups", () => {
    expect(extractRtf("{\\rtf1{\\*\\generator x;}\\uc0 caf\\u233 \\par{\\i italic}}")).toBe("café\nitalic")
  })

  test("binary strings fallback", () => {
    const enc = new TextEncoder()
    const buf = new Uint8Array([0, 1, ...enc.encode("Hello hidden text"), 0, 2, 3])
    expect(binaryStrings(buf)).toContain("Hello hidden text")
  })

  test("email without MIME parts", () => {
    expect(extractEmail("Subject: Hi\nFrom: a@b.c\n\nBody line")).toBe("Subject: Hi\nFrom: a@b.c\n\nBody line")
  })

  test("zip reader lists entries", async () => {
    const zip = new ZipReader(new Uint8Array(await Bun.file(join(FIXTURES, "docs/book.epub")).arrayBuffer()))
    expect(zip.names()).toContain("OEBPS/chap1.xhtml")
    expect(zip.text("mimetype")).toBe("application/epub+zip")
    expect(zip.read("missing")).toBeNull()
  })

  test("kinds", () => {
    expect(kindOf("Report.PDF")).toBe("pdf")
    expect(kindOf("main.rs")).toBe("code")
    expect(kindOf("Dockerfile")).toBe("code")
    expect(kindOf("README")).toBe("text")
    expect(kindOf("photos", true)).toBe("folder")
    expect(kindOf("Safari.app", true)).toBe("app")
    expect(kindOf(".bashrc")).toBe("data")
    expect(extOf(".bashrc")).toBe("")
    expect(extOf("archive.tar.gz")).toBe("gz")
  })
})
