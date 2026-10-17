/** Readable fields of iCalendar and vCard exports. Never follow URIs or decode attachments.
 * Content-line folding and text escapes follow RFC 5545 §3.1/3.3.11 and RFC 6350 §3/4.1.
 */
const calendar = new Set("SUMMARY DESCRIPTION LOCATION DTSTART DTEND DUE CATEGORIES COMMENT CONTACT ORGANIZER ATTENDEE STATUS URL".split(" "))
const contact = new Set("FN N NICKNAME ORG TITLE ROLE NOTE EMAIL TEL ADR URL CATEGORIES BDAY IMPP".split(" "))

export function extractPim(src: string, ext: string): string {
  const lines = src.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n")
  const type = ext === "ics" ? "VCALENDAR" : "VCARD"
  if (!lines.some((line) => line.toUpperCase() === `BEGIN:${type}`)) return ""
  const fields = ext === "ics" ? calendar : contact
  const out: string[] = []
  for (const line of lines) {
    let quoted = false, colon = -1
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted
      if (line[i] === ":" && !quoted) { colon = i; break }
    }
    if (colon < 0) continue
    const head = line.slice(0, colon)
    const key = head.split(";", 1)[0]!.split(".").at(-1)!.toUpperCase()
    // vCard 2.1 transfer encodings and binary properties need a separate decoder.
    if (!fields.has(key) || /;(?:ENCODING|CHARSET)=/i.test(head) || /;VALUE=BINARY(?:;|$)/i.test(head)) continue
    const value = line.slice(colon + 1).replace(/\\([nN,;\\])/g, (_, c: string) => /[nN]/.test(c) ? "\n" : c).trim()
    if (value) out.push(`${key}: ${value}`)
  }
  return out.join("\n")
}
