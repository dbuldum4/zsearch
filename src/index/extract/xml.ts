/** Tiny tolerant XML/HTML text extraction helpers (no DOM, linear scanner). */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  deg: "°",
  times: "×",
  divide: "÷",
  shy: "",
  zwj: "",
  zwnj: "",
}

export function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m
      try {
        return String.fromCodePoint(code)
      } catch {
        return m
      }
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()]
    return named ?? m
  })
}

interface XmlTextSpec {
  preserveWhitespace?: boolean
  /** If set, only text inside one of these elements is kept. */
  textTags?: Set<string>
  /** Content of these elements is dropped entirely. */
  skipTags?: Set<string>
  /** Emit "\n" when these elements close. */
  newlineAfter?: Set<string>
  /** Emit "\t" when these elements close. */
  tabAfter?: Set<string>
  /** Emit "\f" (page/section break) when these elements close. */
  pageAfter?: Set<string>
  /** Elements (usually empty) that stand for a newline, tab or space. */
  newlineTags?: Set<string>
  tabTags?: Set<string>
  spaceTags?: Set<string>
}

/** Linear tolerant scanner: malformed tags never rescan the remaining input. */
function* xmlTokens(s: string): Generator<{ text?: string; cdata?: boolean; kind?: string; name?: string; attrs?: string; selfClosing?: boolean; start?: number; end?: number }> {
  let i = 0
  while (i < s.length) {
    if (s[i] !== "<") {
      const end = s.indexOf("<", i)
      const next = end < 0 ? s.length : end
      yield { text: s.slice(i, next) }; i = next; continue
    }
    if (s.startsWith("<!--", i) || s.startsWith("<![CDATA[", i)) {
      const cdata = s.startsWith("<![CDATA[", i)
      const start = i + (cdata ? 9 : 4)
      const end = s.indexOf(cdata ? "]]>" : "-->", start)
      if (cdata) yield { text: s.slice(start, end < 0 ? s.length : end), cdata: true }
      i = end < 0 ? s.length : end + 3; continue
    }
    const start = i++
    let quote = ""
    while (i < s.length && s[i] !== "<") {
      const c = s[i]!
      if (quote) { if (c === quote) quote = "" }
      else if (c === '"' || c === "'") quote = c
      else if (c === ">") break
      i++
    }
    if (s[i] !== ">") continue
    const tag = s.slice(start + 1, i++)
    const m = /^([/?!]?)([A-Za-z_][\w:.-]*)([\s\S]*)$/.exec(tag)
    if (m) yield { kind: m[1], name: m[2], attrs: m[3], start, end: i, selfClosing: /\/\s*$/.test(m[3]!) }
  }
}

/** Extract readable text from an XML document according to `spec`. */
export function xmlText(xml: string, spec: XmlTextSpec): string {
  const out: string[] = []
  let textDepth = 0
  let skipDepth = 0
  const { textTags, skipTags, newlineAfter, tabAfter, pageAfter, newlineTags, tabTags, spaceTags } = spec
  for (const m of xmlTokens(xml)) {
    if (m.text !== undefined) {
      if (skipDepth === 0 && (!textTags || textDepth > 0)) out.push(m.cdata ? m.text : decodeEntities(m.text))
      continue
    }
    const kind = m.kind
    const name = m.name
    if (!name || kind === "!" || kind === "?") continue
    const selfClosing = m.selfClosing
    const closing = kind === "/"
    if (skipTags?.has(name)) {
      if (selfClosing) continue
      skipDepth += closing ? -1 : 1
      if (skipDepth < 0) skipDepth = 0
      continue
    }
    if (skipDepth > 0) continue
    if (textTags?.has(name) && !selfClosing) textDepth += closing ? -1 : 1
    if (textDepth < 0) textDepth = 0
    if (!closing) {
      if (newlineTags?.has(name)) out.push("\n")
      else if (tabTags?.has(name)) out.push("\t")
      else if (spaceTags?.has(name)) {
        const c = /\bc="(\d+)"/.exec(m.attrs ?? "")
        out.push(" ".repeat(Math.min(64, c ? Number(c[1]) : 1)))
      }
    }
    if (closing || selfClosing) {
      if (pageAfter?.has(name)) out.push("\f")
      else if (newlineAfter?.has(name)) out.push("\n")
      else if (tabAfter?.has(name)) out.push("\t")
    }
  }
  return spec.preserveWhitespace ? out.join("") : tidy(tidyCells(out.join("")))
}

/** Paragraph breaks inside table cells: "a\n\tb\n\t\n" -> "a\tb\n". */
function tidyCells(s: string): string {
  return s.replace(/\n+/g, (run, offset, text) => text[offset + run.length] === "\t" ? "" : run).replace(/\t+/g, (run, offset, text) => text[offset + run.length] === "\n" ? "" : run)
}

/**
 * Collapse runs of blank lines and trailing whitespace. Page breaks (form feeds) before text are
 * kept, including those of pages without text, so the Nth break still starts the (N+1)th page.
 * Breaks at the end start no page with text and are dropped.
 */
export function tidy(s: string): string {
  const text = s.replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, (run, offset, text) => text[offset + run.length] === "\n" ? "" : run)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\S\f]+/g, (run, offset, text) => text[offset - 1] === "\f" || (text[offset + run.length] === "\f" && /^[ \t\n]+$/.test(run)) ? "" : run)
  let first = 0
  while (first < text.length && text[first] !== "\f" && /\s/.test(text[first]!)) first++
  return text.slice(first).trimEnd()
}

/** Non-overlapping XML elements, scanned once even when closing tags are missing. */
export function* xmlElements(xml: string, name: string): Generator<{ attrs: string; body: string }> {
  let open: { start: number; attrs: string } | null = null
  for (const token of xmlTokens(xml)) {
    if (token.name !== name) continue
    if (token.kind === "/") {
      if (open) yield { attrs: open.attrs, body: xml.slice(open.start, token.start) }
      open = null
    } else if (token.selfClosing) { yield { attrs: token.attrs ?? "", body: "" }; open = null }
    else open = { start: token.end!, attrs: token.attrs ?? "" }
  }
}

const HTML_BLOCK = new Set(
  "p div br li ul ol dl dt dd h1 h2 h3 h4 h5 h6 tr table section article header footer aside nav blockquote pre hr title figure figcaption main address details summary caption form fieldset legend".split(
    " ",
  ),
)

/** Visible text of an HTML/XHTML document. */
export function htmlText(html: string): string {
  const out: string[] = []
  const skip = new Set(["script", "style", "noscript", "template", "svg"])
  let skipped = 0, inHead = 0, inTitle = 0
  for (const m of xmlTokens(html)) {
    if (m.text !== undefined) {
      if (!skipped && (!inHead || inTitle)) out.push(decodeEntities(m.text).replace(/[ \t\r\n]+/g, " "))
      continue
    }
    if (!m.name || m.kind === "!" || m.kind === "?") continue
    const tag = m.name.toLowerCase(), closing = m.kind === "/"
    if (skip.has(tag)) { if (!m.selfClosing) skipped = Math.max(0, skipped + (closing ? -1 : 1)); continue }
    if (tag === "head") inHead = closing ? 0 : 1
    if (tag === "title") inTitle = closing ? 0 : 1
    if (skipped) continue
    if (HTML_BLOCK.has(tag)) out.push("\n")
    else if (tag === "td" || tag === "th") out.push("\t")
  }
  return tidy(out.join("").replace(/ +/g, (run, offset, text) => text[offset - 1] === "\n" || text[offset + run.length] === "\n" ? "" : run))
}
