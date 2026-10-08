/**
 * Turn a regular expression into a boolean condition over literal strings that every
 * match must contain (in the spirit of Russ Cox's trigram index analysis). The search
 * engine maps those literals onto the word index to find candidate files cheaply and
 * then runs the real regex on the candidates only.
 */

export type Req = { t: "all" } | { t: "lit"; s: string } | { t: "and"; items: Req[] } | { t: "or"; items: Req[] }

const ALL: Req = { t: "all" }
const MAX_EXACT = 16

interface Info {
  /** Every string the node can match, when that set is small; else null. */
  exact: Set<string> | null
  /** Condition on the text for nodes whose exact set is unknown. */
  match: Req
}

type Node =
  | { k: "lit"; c: string }
  | { k: "any" } // ., \d, \w, big classes
  | { k: "class"; chars: string[] }
  | { k: "empty" } // anchors, lookarounds, \b
  | { k: "cat"; items: Node[] }
  | { k: "alt"; items: Node[] }
  | { k: "rep"; node: Node; min: number; max: number }
  | { k: "group"; node: Node }

class Parser {
  i = 0
  constructor(
    private s: string,
    private ci: boolean,
  ) {}

  parse(): Node {
    const n = this.alt()
    return n
  }

  private alt(): Node {
    const items = [this.cat()]
    while (this.s[this.i] === "|") {
      this.i++
      items.push(this.cat())
    }
    return items.length === 1 ? items[0]! : { k: "alt", items }
  }

  private cat(): Node {
    const items: Node[] = []
    while (this.i < this.s.length && this.s[this.i] !== "|" && this.s[this.i] !== ")") {
      let atom = this.atom()
      atom = this.quant(atom)
      items.push(atom)
    }
    return { k: "cat", items }
  }

  private quant(node: Node): Node {
    const c = this.s[this.i]
    let min = 1
    let max = 1
    if (c === "*") [min, max] = [0, Infinity]
    else if (c === "+") [min, max] = [1, Infinity]
    else if (c === "?") [min, max] = [0, 1]
    else if (c === "{") {
      const m = /^\{(\d*)(,?)(\d*)\}/.exec(this.s.slice(this.i))
      if (!m || (m[1] === "" && m[3] === "")) return node
      min = m[1] ? Number(m[1]) : 0
      max = m[2] ? (m[3] ? Number(m[3]) : Infinity) : min
      this.i += m[0].length - 1
    } else return node
    this.i++
    if (this.s[this.i] === "?" || this.s[this.i] === "+") this.i++ // lazy / possessive
    return this.quant({ k: "rep", node, min, max })
  }

  private lit(c: string): Node {
    if (this.ci && c.toLowerCase() !== c.toUpperCase()) return { k: "lit", c: c.toLowerCase() }
    return { k: "lit", c }
  }

  private atom(): Node {
    const c = this.s[this.i]!
    if (c === "(") {
      this.i++
      if (this.s[this.i] === "?") {
        const rest = this.s.slice(this.i)
        if (/^\?[=!]/.test(rest) || /^\?<[=!]/.test(rest)) {
          // lookaround: contributes nothing
          let depth = 1
          this.i++
          while (this.i < this.s.length && depth > 0) {
            if (this.s[this.i] === "\\") this.i++
            else if (this.s[this.i] === "(") depth++
            else if (this.s[this.i] === ")") depth--
            this.i++
          }
          return { k: "empty" }
        }
        const named = /^\?<[A-Za-z_]\w*>|^\?P<[A-Za-z_]\w*>|^\?:|^\?[imsx-]+:?/.exec(rest)
        if (named) this.i += named[0].length
      }
      const inner = this.alt()
      if (this.s[this.i] === ")") this.i++
      return { k: "group", node: inner }
    }
    if (c === "[") return this.cls()
    if (c === ".") {
      this.i++
      return { k: "any" }
    }
    if (c === "^" || c === "$") {
      this.i++
      return { k: "empty" }
    }
    if (c === "\\") return this.escape(false) as Node
    this.i++
    return this.lit(c)
  }

  /** Parse an escape. In a class, returns the literal char(s) or null for "too many". */
  private escape(inClass: boolean): Node | string[] | null {
    this.i++ // backslash
    const c = this.s[this.i++]
    if (c === undefined) return inClass ? [] : { k: "empty" }
    if ("dDwWsSpPX".includes(c)) {
      if ((c === "p" || c === "P") && this.s[this.i] === "{") this.i = this.s.indexOf("}", this.i) + 1 || this.s.length
      return inClass ? null : { k: "any" }
    }
    if ("bBAzZG".includes(c)) return inClass ? [] : { k: "empty" }
    if (/[1-9]/.test(c)) return inClass ? [] : { k: "any" } // backreference
    if (c === "k" && this.s[this.i] === "<") {
      this.i = this.s.indexOf(">", this.i) + 1 || this.s.length
      return inClass ? [] : { k: "any" }
    }
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", "0": "\0" }
    let ch: string
    if (c in simple) ch = simple[c]!
    else if (c === "x" && /^[0-9a-fA-F]{2}/.test(this.s.slice(this.i))) {
      ch = String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 2), 16))
      this.i += 2
    } else if (c === "u" && /^[0-9a-fA-F]{4}/.test(this.s.slice(this.i))) {
      ch = String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16))
      this.i += 4
    } else if (c === "u" && this.s[this.i] === "{") {
      const end = this.s.indexOf("}", this.i)
      ch = String.fromCodePoint(parseInt(this.s.slice(this.i + 1, end), 16) || 0)
      this.i = end + 1
    } else ch = c
    if (inClass) return [ch]
    return this.lit(ch)
  }

  private cls(): Node {
    this.i++ // [
    let negate = false
    if (this.s[this.i] === "^") {
      negate = true
      this.i++
    }
    const chars = new Set<string>()
    let tooMany = false
    let first = true
    while (this.i < this.s.length && (this.s[this.i] !== "]" || first)) {
      first = false
      let lo: string | null
      if (this.s[this.i] === "\\") {
        const e = this.escape(true) as string[] | null
        if (e === null) {
          tooMany = true
          continue
        }
        lo = e[0] ?? null
      } else lo = this.s[this.i++]!
      if (this.s[this.i] === "-" && this.s[this.i + 1] !== "]" && this.i + 1 < this.s.length && lo !== null) {
        this.i++
        let hi: string | undefined
        if (this.s[this.i] === "\\") hi = ((this.escape(true) as string[] | null) ?? [])[0]
        else hi = this.s[this.i++]
        if (hi === undefined) continue
        const a = lo.charCodeAt(0)
        const b = hi.charCodeAt(0)
        if (b - a > 8) tooMany = true
        else for (let x = a; x <= b; x++) chars.add(String.fromCharCode(x))
      } else if (lo !== null) chars.add(lo)
    }
    if (this.s[this.i] === "]") this.i++
    if (negate || tooMany) return { k: "any" }
    const folded = new Set([...chars].map((ch) => (this.ci ? ch.toLowerCase() : ch)))
    if (folded.size > 8) return { k: "any" }
    return { k: "class", chars: [...folded] }
  }
}

function and(a: Req, b: Req): Req {
  if (a.t === "all") return b
  if (b.t === "all") return a
  const items = [...(a.t === "and" ? a.items : [a]), ...(b.t === "and" ? b.items : [b])]
  return { t: "and", items }
}

function or(a: Req, b: Req): Req {
  if (a.t === "all" || b.t === "all") return ALL
  const items = [...(a.t === "or" ? a.items : [a]), ...(b.t === "or" ? b.items : [b])]
  return { t: "or", items }
}

/** Convert an exact set into a condition. Strings shorter than `minLen` make it useless. */
function exactToReq(set: Set<string>, minLen: number): Req {
  if (set.size === 0) return ALL
  let r: Req | null = null
  for (const s of set) {
    if (s.length < minLen) return ALL
    r = r ? or(r, { t: "lit", s }) : { t: "lit", s }
  }
  return r ?? ALL
}

function cross(a: Set<string>, b: Set<string>): Set<string> | null {
  if (a.size * b.size > MAX_EXACT) return null
  const out = new Set<string>()
  for (const x of a) for (const y of b) out.add(x + y)
  return out
}

const MIN_LIT = 2

function analyze(n: Node): Info {
  switch (n.k) {
    case "lit":
      return { exact: new Set([n.c]), match: ALL }
    case "class":
      return { exact: new Set(n.chars), match: ALL }
    case "any":
      return { exact: null, match: ALL }
    case "empty":
      return { exact: new Set([""]), match: ALL }
    case "group":
      return analyze(n.node)
    case "alt": {
      const infos = n.items.map(analyze)
      if (infos.every((i) => i.exact)) {
        const u = new Set<string>()
        for (const i of infos) for (const s of i.exact!) u.add(s)
        if (u.size <= MAX_EXACT) return { exact: u, match: ALL }
      }
      let r: Req | null = null
      for (const i of infos) {
        const req = i.exact ? exactToReq(i.exact, MIN_LIT) : i.match
        r = r ? or(r, req) : req
      }
      return { exact: null, match: r ?? ALL }
    }
    case "rep": {
      const inner = analyze(n.node)
      if (n.min === 0) {
        if (n.max === 1 && inner.exact) {
          const s = new Set(inner.exact)
          s.add("")
          if (s.size <= MAX_EXACT) return { exact: s, match: ALL }
        }
        return { exact: null, match: ALL }
      }
      // x{n,m} with n >= 1: at least one copy must be present.
      if (inner.exact && n.max === n.min && n.min <= 4) {
        let acc: Set<string> | null = new Set([""])
        for (let k = 0; k < n.min && acc; k++) acc = cross(acc, inner.exact)
        if (acc) return { exact: acc, match: ALL }
      }
      return { exact: null, match: inner.exact ? exactToReq(inner.exact, MIN_LIT) : inner.match }
    }
    case "cat": {
      let exact: Set<string> | null = new Set([""])
      let match: Req = ALL
      for (const item of n.items) {
        const info = analyze(item)
        if (exact && info.exact) {
          const c = cross(exact, info.exact)
          if (c && [...c].every((s) => s.length <= 64)) {
            exact = c
            continue
          }
        }
        // Flush what we have and continue with this item.
        if (exact) match = and(match, exactToReq(exact, MIN_LIT))
        if (info.exact) exact = info.exact
        else {
          match = and(match, info.match)
          exact = new Set([""])
        }
      }
      if (exact && exact.size === 1 && exact.has("")) return { exact: n.items.length ? null : exact, match }
      return { exact, match }
    }
  }
}

/** Literal requirements of a regex. `caseInsensitive` folds literals to lower case. */
export function regexRequirements(pattern: string, caseInsensitive: boolean): Req {
  let node: Node
  try {
    node = new Parser(pattern, caseInsensitive).parse()
  } catch {
    return ALL
  }
  const info = analyze(node)
  let r = info.match
  if (info.exact) r = and(r, exactToReq(info.exact, MIN_LIT))
  return simplify(r)
}

function simplify(r: Req): Req {
  if (r.t === "and") {
    const items = r.items.map(simplify).filter((x) => x.t !== "all")
    const uniq = dedupe(items)
    return uniq.length === 0 ? ALL : uniq.length === 1 ? uniq[0]! : { t: "and", items: uniq }
  }
  if (r.t === "or") {
    const items = r.items.map(simplify)
    if (items.some((x) => x.t === "all")) return ALL
    const uniq = dedupe(items)
    return uniq.length === 1 ? uniq[0]! : { t: "or", items: uniq }
  }
  return r
}

function dedupe(items: Req[]): Req[] {
  const seen = new Set<string>()
  return items.filter((x) => {
    const k = JSON.stringify(x)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Requirement for a plain literal search. */
export function literalRequirement(s: string, caseInsensitive: boolean): Req {
  const lit = caseInsensitive ? s.toLowerCase() : s
  return lit.length >= MIN_LIT ? { t: "lit", s: lit } : ALL
}
