/** Tiny tolerant XML/HTML text extraction helpers (no DOM, regex tokenizer). */

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

export interface XmlTextSpec {
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

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<([/?!]?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)|</g

/** Extract readable text from an XML document according to `spec`. */
export function xmlText(xml: string, spec: XmlTextSpec): string {
  const out: string[] = []
  let textDepth = 0
  let skipDepth = 0
  const { textTags, skipTags, newlineAfter, tabAfter, pageAfter, newlineTags, tabTags, spaceTags } = spec
  TOKEN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(xml))) {
    const text = m[6] ?? m[1]
    if (text !== undefined) {
      if (skipDepth === 0 && (!textTags || textDepth > 0)) out.push(m[1] !== undefined ? text : decodeEntities(text))
      continue
    }
    const kind = m[2]
    const name = m[3]
    if (!name || kind === "!" || kind === "?") continue
    const selfClosing = m[5] === "/"
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
        const c = /\bc="(\d+)"/.exec(m[4] ?? "")
        out.push(" ".repeat(Math.min(64, c ? Number(c[1]) : 1)))
      }
    }
    if (closing || selfClosing) {
      if (pageAfter?.has(name)) out.push("\f")
      else if (newlineAfter?.has(name)) out.push("\n")
      else if (tabAfter?.has(name)) out.push("\t")
    }
  }
  return tidy(tidyCells(out.join("")))
}

/** Paragraph breaks inside table cells: "a\n\tb\n\t\n" -> "a\tb\n". */
export function tidyCells(s: string): string {
  return s.replace(/\n+\t/g, "\t").replace(/\t+\n/g, "\n")
}

/** Collapse runs of blank lines and trailing whitespace. */
export function tidy(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t\n]*\f\s*/g, "\f")
    .replace(/^\s+|\s+$/g, "")
}

const HTML_BLOCK = new Set(
  "p div br li ul ol dl dt dd h1 h2 h3 h4 h5 h6 tr table section article header footer aside nav blockquote pre hr title figure figcaption main address details summary caption form fieldset legend".split(
    " ",
  ),
)

/** Visible text of an HTML/XHTML document. */
export function htmlText(html: string): string {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, (m, tag: string) => (tag.toLowerCase() === "head" ? titleOf(m) : " "))
  const out: string[] = []
  const re = /<\/?([A-Za-z][\w:-]*)(?:[^>"']|"[^"]*"|'[^']*')*>|([^<]+)|</g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    if (m[2] !== undefined) out.push(decodeEntities(m[2]).replace(/[ \t\r\n]+/g, " "))
    else if (m[1]) {
      const tag = m[1].toLowerCase()
      if (HTML_BLOCK.has(tag)) out.push("\n")
      else if (tag === "td" || tag === "th") out.push("\t")
    }
  }
  return tidy(out.join("").replace(/ *\n */g, "\n"))
}

function titleOf(head: string): string {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)
  return t ? `\n${t[1]}\n` : " "
}
