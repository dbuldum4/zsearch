export type QueryExpression = { op: "leaf"; text: string } | { op: "and" | "or"; parts: QueryExpression[] }

/** Parentheses and OR outside quoted strings. Ordinary text keeps exact-text semantics. */
export function booleanQuery(raw: string): QueryExpression | null {
  if (/^\s*(?:re:|regex:|\/)/i.test(raw) || !/(?:\bOR\b|(?:^|\s)\()/.test(raw)) return null
  let nodes = 0
  const parse = (text: string, depth: number): QueryExpression => {
    if (++nodes > 64 || depth > 12) throw new Error("query has too many groups")
    text = text.trim()
    const ors: string[] = []
    const groups: { start: number; end: number }[] = []
    let quoted = false, level = 0, start = 0, groupStart = 0
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue }
      if (text[i] === '"') { quoted = !quoted; continue }
      if (quoted) continue
      if (text[i] === "(") { if (!level) groupStart = i; level++ }
      else if (text[i] === ")") {
        if (--level < 0) throw new Error("unmatched query parenthesis")
        if (!level) groups.push({ start: groupStart, end: i })
      } else if (!level && text.slice(i, i + 2) === "OR" && (i === 0 || /\s/.test(text[i - 1]!)) && (i + 2 === text.length || /\s/.test(text[i + 2]!))) {
        ors.push(text.slice(start, i)); start = i + 2; i++
      }
    }
    if (level) throw new Error("unmatched query parenthesis")
    if (ors.length) { ors.push(text.slice(start)); return { op: "or", parts: ors.map((s) => { if (!s.trim()) throw new Error("OR needs text on both sides"); return parse(s, depth + 1) }) } }
    if (!groups.length) return { op: "leaf", text }
    const parts: QueryExpression[] = []
    start = 0
    for (const group of groups) {
      if (text.slice(start, group.start).trim()) parts.push({ op: "leaf", text: text.slice(start, group.start).trim() })
      parts.push(parse(text.slice(group.start + 1, group.end), depth + 1))
      start = group.end + 1
    }
    if (text.slice(start).trim()) parts.push({ op: "leaf", text: text.slice(start).trim() })
    return parts.length === 1 ? parts[0]! : { op: "and", parts }
  }
  const result = parse(raw, 0)
  return result.op === "leaf" && result.text === raw ? null : result
}
