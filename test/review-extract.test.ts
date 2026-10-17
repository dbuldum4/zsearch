import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractXls } from "../src/index/extract/legacy.ts"
import { ocrBlankPages, tidyPages } from "../src/index/extract/ocr.ts"
import { extractEmail } from "../src/index/extract/text.ts"
import { KIND_ALIASES, kindOf } from "../src/kinds.ts"

/** A compound file holding one stream, `Workbook`, in regular 512-byte sectors. */
function cfb(stream: Uint8Array): Uint8Array {
  const sectors = Math.ceil(stream.length / 512)
  if (sectors + 2 > 128) throw new Error("stream too large for one FAT sector")
  const out = new Uint8Array(512 * (3 + sectors))
  const v = new DataView(out.buffer)
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  v.setUint16(0x1a, 3, true)
  v.setUint16(0x1c, 0xfffe, true)
  v.setUint16(0x1e, 9, true)
  v.setUint16(0x20, 6, true)
  v.setUint32(0x2c, 1, true)
  v.setUint32(0x30, 1, true)
  v.setUint32(0x38, 4096, true)
  v.setUint32(0x3c, 0xfffffffe, true)
  v.setUint32(0x44, 0xfffffffe, true)
  for (let i = 0; i < 109; i++) v.setUint32(0x4c + i * 4, i === 0 ? 0 : 0xffffffff, true)
  // FAT (sector 0): itself, the directory, then the stream's chain.
  const fat = 512
  for (let i = 0; i < 128; i++) v.setUint32(fat + i * 4, 0xffffffff, true)
  v.setUint32(fat, 0xfffffffd, true)
  v.setUint32(fat + 4, 0xfffffffe, true)
  for (let s = 0; s < sectors; s++) v.setUint32(fat + (2 + s) * 4, s === sectors - 1 ? 0xfffffffe : 3 + s, true)
  // Directory (sector 1).
  const entry = (i: number, name: string, type: number, start: number, size: number) => {
    const off = 1024 + i * 128
    for (let c = 0; c < name.length; c++) v.setUint16(off + c * 2, name.charCodeAt(c), true)
    v.setUint16(off + 0x40, (name.length + 1) * 2, true)
    out[off + 0x42] = type
    v.setUint32(off + 0x74, start, true)
    v.setUint32(off + 0x78, size, true)
  }
  entry(0, "Root Entry", 5, 0xfffffffe, 0)
  entry(1, "Workbook", 2, 2, stream.length)
  out.set(stream, 512 * 3)
  return out
}

function record(type: number, data: number[]): number[] {
  return [type & 0xff, type >> 8, data.length & 0xff, data.length >> 8, ...data]
}

const u16 = (n: number) => [n & 0xff, n >> 8]
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24]

describe("legacy .xls", () => {
  test("repeated shared strings stop expanding at the text budget", () => {
    const long = "x".repeat(2000)
    const sst = [...u32(1), ...u32(1), ...u16(long.length), 0, ...Array.from(long, (c) => c.charCodeAt(0))]
    const bytes = [...record(0x00fc, sst), ...record(0x0809, [...u16(0x0600), ...u16(0x0010), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]
    // 4000 cells, all the same 2000-char string: 8M chars unbounded, from a ~60 KB file.
    for (let row = 0; row < 4000; row++) bytes.push(...record(0x00fd, [...u16(row), 0, 0, 0, 0, ...u32(0)]))
    const file = cfb(new Uint8Array(bytes))
    expect(file.length).toBeLessThan(64 * 1024)
    const t = extractXls(file, 10_000)
    expect(t.startsWith(`Sheet1\n${long}\n${long}`)).toBe(true)
    expect(t.length).toBeLessThan(10_000 + 2 * long.length)
    expect(extractXls(file).length).toBeLessThan(2_000_000 + 2 * long.length)
  })
})

describe("kinds", () => {
  test("names that are Object.prototype properties", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "constructor.bak"]) expect(kindOf(name)).toBe("other")
    expect(kindOf("Makefile")).toBe("code")
    expect(kindOf("LICENSE.old")).toBe("text")
  })

  test("type aliases are own properties only", () => {
    expect(KIND_ALIASES["constructor"]).toBeUndefined()
    expect(KIND_ALIASES["__proto__"]).toBeUndefined()
    expect(KIND_ALIASES["pdf"]).toEqual(["pdf"])
    expect(Object.keys(KIND_ALIASES)).toContain("spreadsheet")
  })
})

describe("PDF OCR page selection", () => {
  test("trailing pages without text survive tidying", () => {
    // pdftotext ends every page with a form feed: a cover and two scanned pages.
    expect(tidyPages("Cover text  \n\f\f")).toBe("Cover text\f\f")
    expect(tidyPages("Cover text\n\n")).toBe("Cover text")
    expect(tidyPages("  first\fsecond\f \n\f")).toBe("first\fsecond\f\f")
  })

  test("a text cover followed by scanned pages is OCR'd", async () => {
    const root = mkdtempSync(join(tmpdir(), "zsearch-ocr-pages-"))
    try {
      const helper = join(root, "helper")
      writeFileSync(helper, `#!${process.execPath}\nawait Bun.write(Bun.stdout, "\\fscanned appendix\\fmore scans")\n`, { mode: 0o700 })
      expect(await ocrBlankPages(helper, "unused.pdf", tidyPages("Cover page text\f\f"), 10_000)).toBe("Cover page text\fscanned appendix\fmore scans")
      // Nothing to OCR: the text comes back tidied.
      expect(await ocrBlankPages(join(root, "missing"), "unused.pdf", "First page\fSecond page \n", 10_000)).toBe("First page\fSecond page")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe("email", () => {
  test("closing boundary ends the parts of an HTML-only alternative", () => {
    const eml = [
      "Subject: Html only",
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>The actual body</p>",
      "--b1--",
      "",
      "",
    ].join("\r\n")
    expect(extractEmail(eml)).toContain("The actual body")
  })

  test("epilogue after the closing boundary is not a part", () => {
    const eml = 'Content-Type: multipart/mixed; boundary="b"\n\n--b\nContent-Type: text/plain\n\nBody\n--b--\nEpilogue noise\n'
    expect(extractEmail(eml)).toBe("Body")
  })

  test("legacy charsets decode from the original bytes", () => {
    const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))
    const plain = latin1("Subject: caf\xe9\nContent-Type: text/plain; charset=windows-1252\nContent-Transfer-Encoding: 8bit\n\ncaf\xe9 r\xe9sum\xe9 \x93quoted\x94\n")
    expect(extractEmail(plain)).toBe("Subject: café\n\ncafé résumé “quoted”")
    const multipart = latin1('Content-Type: multipart/mixed; boundary="b"\n\n--b\nContent-Type: text/plain; charset=iso-8859-1\n\ncaf\xe9\n--b\nContent-Type: text/plain; charset=windows-1252\nContent-Transfer-Encoding: quoted-printable\n\nr=E9sum=E9\n--b--\n')
    expect(extractEmail(multipart)).toBe("café\n\nrésumé")
  })

  test("UTF-8 emails still decode, as bytes or text", () => {
    const eml = "Subject: =?utf-8?q?gr=C3=BC=C3=9Fe?= ünd\nContent-Type: text/plain; charset=utf-8\n\nZürich – ✓\n"
    const expected = "Subject: grüße ünd\n\nZürich – ✓"
    expect(extractEmail(new TextEncoder().encode(eml))).toBe(expected)
    expect(extractEmail(eml)).toBe(expected)
    const qp = "Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nZ=C3=BCrich ✓\n"
    expect(extractEmail(new TextEncoder().encode(qp))).toBe("Zürich ✓")
    const b64 = `Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${Buffer.from("Zürich").toString("base64")}\n`
    expect(extractEmail(b64)).toBe("Zürich")
    expect(extractEmail(new TextEncoder().encode("Subject: Hi\n\nNo charset: Zürich"))).toBe("Subject: Hi\n\nNo charset: Zürich")
  })
})
