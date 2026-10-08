import { posix } from "node:path"
import { ZipReader } from "./zip.ts"
import { decodeEntities, htmlText, tidy, xmlText } from "./xml.ts"

const set = (s: string) => new Set(s.split(" "))

/* ----------------------------------------------------------------- DOCX -- */

const DOCX_SPEC = {
  textTags: set("w:t"),
  skipTags: set("w:instrText w:delText mc:Fallback"),
  newlineAfter: set("w:p w:tr"),
  tabAfter: set("w:tc"),
  newlineTags: set("w:br w:cr"),
  tabTags: set("w:tab"),
}

export function extractDocx(buf: Uint8Array): string {
  const zip = new ZipReader(buf)
  const main = zip.text("word/document.xml")
  if (main === null) throw new Error("not a Word document (word/document.xml missing)")
  const parts = [xmlText(main, DOCX_SPEC)]
  const extra = zip
    .names()
    .filter((n) => /^word\/(header|footer|footnotes|endnotes|comments)\d*\.xml$/.test(n))
    .sort(naturalCompare)
  for (const name of extra) {
    const t = xmlText(zip.text(name) ?? "", DOCX_SPEC)
    if (t) parts.push(t)
  }
  return tidy(parts.join("\n\n"))
}

/* ----------------------------------------------------------------- PPTX -- */

const PPTX_SPEC = {
  textTags: set("a:t"),
  skipTags: set("mc:Fallback"),
  newlineAfter: set("a:p"),
  newlineTags: set("a:br"),
  tabTags: set("a:tab"),
}

/** Slides separated by form feeds; speaker notes follow each slide's text. */
export function extractPptx(buf: Uint8Array): string {
  const zip = new ZipReader(buf)
  const slides = zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort(naturalCompare)
  if (slides.length === 0 && !zip.has("ppt/presentation.xml")) throw new Error("not a PowerPoint file")
  const order = slideOrder(zip) ?? slides
  const pages: string[] = []
  for (const slide of order) {
    const xml = zip.text(slide)
    if (xml === null) continue
    let text = xmlText(xml, PPTX_SPEC)
    const notes = notesFor(zip, slide)
    if (notes) text += (text ? "\n\n" : "") + notes
    pages.push(text)
  }
  return tidy(pages.join("\f"))
}

function relsOf(zip: ZipReader, part: string): Map<string, { target: string; type: string }> {
  const dir = posix.dirname(part)
  const relsPath = `${dir}/_rels/${posix.basename(part)}.rels`
  const xml = zip.text(relsPath)
  const map = new Map<string, { target: string; type: string }>()
  if (!xml) return map
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1]!
    const id = /\bId="([^"]*)"/.exec(attrs)?.[1]
    const target = /\bTarget="([^"]*)"/.exec(attrs)?.[1]
    const type = /\bType="([^"]*)"/.exec(attrs)?.[1] ?? ""
    if (!id || !target) continue
    const resolved = target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join(dir, decodeEntities(target)))
    map.set(id, { target: resolved, type })
  }
  return map
}

function slideOrder(zip: ZipReader): string[] | null {
  const pres = zip.text("ppt/presentation.xml")
  if (!pres) return null
  const rels = relsOf(zip, "ppt/presentation.xml")
  const order: string[] = []
  for (const m of pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
    const r = rels.get(m[1]!)
    if (r && zip.has(r.target)) order.push(r.target)
  }
  return order.length ? order : null
}

function notesFor(zip: ZipReader, slide: string): string {
  for (const r of relsOf(zip, slide).values()) {
    if (!r.type.endsWith("/notesSlide")) continue
    const xml = zip.text(r.target)
    if (!xml) continue
    // Skip the slide-image placeholder and slide number; keep body text.
    const text = xmlText(xml, PPTX_SPEC)
      .split("\n")
      .filter((l) => !/^\d+$/.test(l.trim()))
      .join("\n")
    return text.trim()
  }
  return ""
}

/* ----------------------------------------------------------------- XLSX -- */

/** Sheets separated by form feeds; first line of each is the sheet name, cells tab-separated. */
export function extractXlsx(buf: Uint8Array, maxChars = 2_000_000): string {
  const zip = new ZipReader(buf)
  const wb = zip.text("xl/workbook.xml")
  if (wb === null) throw new Error("not an Excel workbook (xl/workbook.xml missing)")
  const shared = sharedStrings(zip.text("xl/sharedStrings.xml"))
  const rels = relsOf(zip, "xl/workbook.xml")
  const sheets: { name: string; part: string }[] = []
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = m[1]!
    const name = decodeEntities(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "")
    const rid = /\br:id="([^"]*)"/.exec(attrs)?.[1]
    const part = rid ? rels.get(rid)?.target : undefined
    if (part && zip.has(part)) sheets.push({ name, part })
  }
  if (sheets.length === 0) {
    for (const n of zip.names().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(naturalCompare)) sheets.push({ name: posix.basename(n, ".xml"), part: n })
  }
  const out: string[] = []
  let total = 0
  for (const sheet of sheets) {
    if (total > maxChars) break
    const xml = zip.text(sheet.part) ?? ""
    const rows = sheetRows(xml, shared, maxChars - total)
    const text = `${sheet.name}\n${rows}`
    total += text.length
    out.push(text)
  }
  return tidy(out.join("\f"))
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return []
  const out: string[] = []
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
    const inner = (si[1] ?? "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")
    let s = ""
    for (const t of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += t[1]
    out.push(decodeEntities(s))
  }
  return out
}

function sheetRows(xml: string, shared: string[], budget: number): string {
  const lines: string[] = []
  let size = 0
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!
      const body = c[2] ?? ""
      const t = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? "n"
      let value = ""
      if (t === "s") {
        const idx = Number(/<v>([^<]*)<\/v>/.exec(body)?.[1])
        value = Number.isInteger(idx) ? (shared[idx] ?? "") : ""
      } else if (t === "inlineStr") {
        for (const m of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) value += decodeEntities(m[1]!)
      } else if (t === "b") {
        const v = /<v>([^<]*)<\/v>/.exec(body)?.[1]
        value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : ""
      } else {
        value = decodeEntities(/<v>([^<]*)<\/v>/.exec(body)?.[1] ?? "")
      }
      if (value) cells.push(value.replace(/[\t\n\r]+/g, " "))
    }
    if (cells.length) {
      const line = cells.join("\t")
      lines.push(line)
      size += line.length + 1
      if (size > budget) break
    }
  }
  return lines.join("\n")
}

/* -------------------------------------------------------- OpenDocument -- */

const ODF_SPEC = {
  skipTags: set("office:scripts office:font-face-decls office:automatic-styles office:styles text:tracked-changes text:sequence-decls draw:image svg:desc"),
  newlineAfter: set("text:p text:h table:table-row text:list-header"),
  tabAfter: set("table:table-cell table:covered-table-cell"),
  pageAfter: set("draw:page table:table"),
  newlineTags: set("text:line-break"),
  tabTags: set("text:tab"),
  spaceTags: set("text:s"),
}

export function extractOdf(buf: Uint8Array): string {
  const zip = new ZipReader(buf)
  const xml = zip.text("content.xml")
  if (xml === null) throw new Error("not an OpenDocument file (content.xml missing)")
  const body = /<office:body\b[\s\S]*<\/office:body>/.exec(xml)?.[0] ?? xml
  return xmlText(body, ODF_SPEC)
}

/** Flat (single XML file) OpenDocument: .fodt/.fods/.fodp */
export function extractFlatOdf(xml: string): string {
  const body = /<office:body\b[\s\S]*<\/office:body>/.exec(xml)?.[0] ?? xml
  return xmlText(body, ODF_SPEC)
}

/* ----------------------------------------------------------------- EPUB -- */

export function extractEpub(buf: Uint8Array, maxChars = 2_000_000): string {
  const zip = new ZipReader(buf)
  let docs: string[] = []
  const container = zip.text("META-INF/container.xml")
  const opfPath = container ? /full-path="([^"]+)"/.exec(container)?.[1] : undefined
  const opf = opfPath ? zip.text(opfPath) : null
  if (opfPath && opf) {
    const base = posix.dirname(opfPath)
    const manifest = new Map<string, string>()
    for (const m of opf.matchAll(/<item\b([^>]*)\/?>/g)) {
      const id = /\bid="([^"]+)"/.exec(m[1]!)?.[1]
      const href = /\bhref="([^"]+)"/.exec(m[1]!)?.[1]
      if (id && href) manifest.set(id, posix.normalize(posix.join(base === "." ? "" : base, decodeURIComponent(decodeEntities(href)))))
    }
    for (const m of opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)) {
      const href = manifest.get(m[1]!)
      if (href && zip.has(href)) docs.push(href)
    }
  }
  if (docs.length === 0) docs = zip.names().filter((n) => /\.(x?html?)$/i.test(n)).sort(naturalCompare)
  const out: string[] = []
  let total = 0
  for (const d of docs) {
    const t = htmlText(zip.text(d) ?? "")
    if (!t) continue
    out.push(t)
    total += t.length
    if (total > maxChars) break
  }
  return tidy(out.join("\f"))
}

/* --------------------------------------------------------------- shared -- */

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
}
