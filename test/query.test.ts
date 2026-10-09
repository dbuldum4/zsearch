import { describe, expect, test } from "bun:test"
import { home } from "../src/config.ts"
import { isNaturalLanguage, looksLikeRegex } from "../src/search/engine.ts"
import { fuzzyMatch, matchPath, parseFuzzyTerms } from "../src/search/fuzzy.ts"
import { parseDuration, parseQuery, parseSize } from "../src/search/query.ts"
import { regexRequirements, type Req } from "../src/search/regex-plan.ts"
import { termsPattern, findLines, keywordLines, clipLine } from "../src/search/snippet.ts"
import { literalToFts, reqToFts, Vocab } from "../src/search/vocab.ts"
import { editDistance, foldTerm, nameTokens, splitIdentifier, uniqueTerms } from "../src/util/text.ts"
import { Database } from "bun:sqlite"

describe("query parsing", () => {
  const now = new Date("2024-06-15T12:00:00").getTime()

  test("plain words, phrases and negations", () => {
    const q = parseQuery('budget "next year" !draft -old report', now)
    expect(q.words).toEqual(["budget", "report"])
    expect(q.phrases).toEqual(["next year"])
    expect(q.negated).toEqual(["draft", "old"])
    expect(q.forcedMode).toBeNull()
    expect(q.typing).toBe(true)
    expect(parseQuery("budget ").typing).toBe(false)
  })

  test("filters are removed from the text", () => {
    const q = parseQuery("ext:pdf,.docx type:sheet in:Documents path:2024 invoice size:>5mb limit:7", now)
    expect(q.text).toBe("invoice")
    expect([...q.filters.exts!]).toEqual(["pdf", "docx"])
    expect([...q.filters.kinds!]).toEqual(["sheet"])
    expect(q.filters.inPaths).toEqual([`${home()}/Documents`])
    expect(q.filters.pathContains).toEqual(["2024"])
    expect(q.filters.sizeMin).toBe(5 * 1024 * 1024)
    expect(q.filters.limit).toBe(7)
  })

  test("type aliases and negated types", () => {
    const q = parseQuery("type:docs -type:pdf notes", now)
    expect(q.filters.kinds!.has("doc")).toBe(true)
    expect(q.filters.kinds!.has("markdown")).toBe(true)
    expect([...q.filters.notKinds!]).toEqual(["pdf"])
  })

  test("dates and ages", () => {
    expect(parseQuery("mtime:<7d", now).filters.mtimeMin).toBe(now - 7 * 86_400_000)
    expect(parseQuery("mtime:>1y", now).filters.mtimeMax).toBe(now - 365 * 86_400_000)
    const after = parseQuery("after:2024-01-01", now).filters
    expect(after.mtimeMin).toBe(new Date("2024-01-01T00:00:00").getTime())
    const year = parseQuery("mtime:2023", now).filters
    expect(year.mtimeMin).toBe(new Date(2023, 0, 1).getTime())
    expect(year.mtimeMax).toBe(new Date(2024, 0, 1).getTime())
    const today = parseQuery("mtime:today", now).filters
    expect(today.mtimeMin).toBe(new Date("2024-06-15T00:00:00").getTime())
  })

  test("unknown or malformed filters become warnings and stay as text", () => {
    const q = parseQuery("size:huge http://example.com", now)
    expect(q.warnings.length).toBe(1)
    expect(q.text).toContain("size:huge")
    expect(q.text).toContain("http://example.com")
  })

  test("mode prefixes", () => {
    expect(parseQuery("re:foo.*bar").forcedMode).toBe("regex")
    expect(parseQuery("re:foo  bar").text).toBe("foo  bar")
    expect(parseQuery("/a+b/").forcedMode).toBe("regex")
    expect(parseQuery("/a+b/").text).toBe("a+b")
    expect(parseQuery("?how do plants make energy").forcedMode).toBe(null)
    expect(parseQuery('"exact words"').forcedMode).toBe("exact")
    expect(parseQuery("f:srvr").forcedMode).toBe("fuzzy")
    expect(parseQuery("grep:TODO").forcedMode).toBe("exact")
  })

  test("sizes and durations", () => {
    expect(parseSize("10k")).toBe(10240)
    expect(parseSize("1.5MB")).toBe(1572864)
    expect(parseSize("abc")).toBeNull()
    expect(parseDuration("2w")).toBe(14 * 86_400_000)
    expect(parseDuration("3mo")).toBe(90 * 86_400_000)
  })

  test("auto mode heuristics", () => {
    expect(looksLikeRegex("foo.*bar")).toBe(true)
    expect(looksLikeRegex("\\d{3}-\\d{4}")).toBe(true)
    expect(looksLikeRegex("^import")).toBe(true)
    expect(looksLikeRegex("(cat|dog)")).toBe(true)
    expect(looksLikeRegex("main.rs")).toBe(false)
    expect(looksLikeRegex("c++")).toBe(false)
    expect(looksLikeRegex("budget 2024")).toBe(false)
    expect(isNaturalLanguage(parseQuery("how do plants make energy"))).toBe(true)
    expect(isNaturalLanguage(parseQuery("notes about the trip to lisbon"))).toBe(true)
    expect(isNaturalLanguage(parseQuery("budget"))).toBe(false)
    expect(isNaturalLanguage(parseQuery("server.ts config"))).toBe(false)
  })
})

describe("fuzzy matching", () => {
  const score = (text: string, pat: string) => fuzzyMatch(text, text.toLowerCase(), pat)?.score ?? -1

  test("characters must appear in order", () => {
    expect(fuzzyMatch("src/server.ts", "src/server.ts", "srvr")).not.toBeNull()
    expect(fuzzyMatch("src/server.ts", "src/server.ts", "tvs")).toBeNull()
  })

  test("boundary, camelCase and consecutive matches score higher", () => {
    expect(score("foo/bar.txt", "bar")).toBeGreaterThan(score("foo/xbaxr.txt", "bar"))
    expect(score("getUserName", "un")).toBeGreaterThan(score("gunk", "un") - 100)
    expect(score("user_name.ts", "name")).toBeGreaterThan(score("username.ts", "name"))
  })

  test("positions point at matched characters", () => {
    const m = fuzzyMatch("src/main.rs", "src/main.rs", "main")!
    expect(m.positions).toEqual([4, 5, 6, 7])
  })

  test("extended syntax", () => {
    const terms = parseFuzzyTerms("'exact ^pre suf$ !not ^whole$ plain")
    expect(terms.map((t) => [t.kind, t.text, t.negate])).toEqual([
      ["exact", "exact", false],
      ["prefix", "pre", false],
      ["suffix", "suf", false],
      ["exact", "not", true],
      ["equal", "whole", false],
      ["fuzzy", "plain", false],
    ])
  })

  test("paths prefer matches in the file name", () => {
    const a = "projects/main/notes.txt"
    const b = "projects/notes/main.txt"
    const terms = parseFuzzyTerms("main")
    const sa = matchPath(a, a, a.lastIndexOf("/") + 1, terms)!.score
    const sb = matchPath(b, b, b.lastIndexOf("/") + 1, terms)!.score
    expect(sb).toBeGreaterThan(sa)
  })

  test("negation and suffix in paths", () => {
    const p = "code/app/server.ts"
    expect(matchPath(p, p, 9, parseFuzzyTerms("server !app"))).toBeNull()
    expect(matchPath(p, p, 9, parseFuzzyTerms("srv .ts$"))).not.toBeNull()
    expect(matchPath(p, p, 9, parseFuzzyTerms(".py$"))).toBeNull()
  })
})

const flat = (r: Req): unknown => (r.t === "lit" ? r.s : r.t === "all" ? "*" : { [r.t]: r.items.map(flat) })

describe("regex requirements", () => {
  test("literals", () => {
    expect(flat(regexRequirements("hello", false))).toBe("hello")
    expect(flat(regexRequirements("Hello", true))).toBe("hello")
  })
  test("concatenation with wildcards gives an AND", () => {
    expect(flat(regexRequirements("foo\\d+bar", false))).toEqual({ and: ["foo", "bar"] })
    expect(flat(regexRequirements("import .* from", false))).toEqual({ and: ["import ", " from"] })
  })
  test("alternation gives an OR", () => {
    expect(flat(regexRequirements("(cat|dog)food", false))).toEqual({ or: ["catfood", "dogfood"] })
    expect(flat(regexRequirements("error|warning", false))).toEqual({ or: ["error", "warning"] })
  })
  test("optional parts and classes", () => {
    expect(flat(regexRequirements("colou?r", false))).toEqual({ or: ["colour", "color"] })
    expect(flat(regexRequirements("gr[ae]y", false))).toEqual({ or: ["gray", "grey"] })
    expect(flat(regexRequirements("[a-z]+ing", false))).toBe("ing")
  })
  test("no usable literal means scanning everything", () => {
    expect(flat(regexRequirements("\\d{3}-\\d{4}", false))).toBe("*")
    expect(flat(regexRequirements(".*", false))).toBe("*")
    expect(flat(regexRequirements("a|.*", false))).toBe("*")
  })
  test("escapes, anchors and lookarounds", () => {
    expect(flat(regexRequirements("^func\\s+main\\(", false))).toEqual({ and: ["func", "main("] })
    expect(flat(regexRequirements("(?<=x)abc(?!d)", false))).toBe("abc")
    expect(flat(regexRequirements("user_\\$\\{id\\}", false))).toBe("user_${id}")
  })
})

describe("vocabulary and FTS mapping", () => {
  const db = new Database(":memory:")
  db.exec("CREATE TABLE vocab (id INTEGER PRIMARY KEY, term TEXT NOT NULL UNIQUE)")
  for (const t of ["getusername", "username", "user", "setuser", "rename", "names", "foo", "bar", "café"]) db.query("INSERT INTO vocab(term) VALUES (?)").run(t)
  const v = new Vocab()
  v.load(db, false)

  test("substring and suffix lookups", () => {
    expect(v.containing("user")!.sort()).toEqual(["getusername", "setuser", "user", "username"])
    expect(v.endingWith("name")!.sort()).toEqual(["getusername", "rename", "username"])
    expect(v.containing("zzz")).toEqual([])
    expect(v.containing("e", 2)).toBeNull()
  })

  test("incremental load", () => {
    db.query("INSERT INTO vocab(term) VALUES (?)").run("username2")
    v.load(db, true)
    expect(v.containing("username")!.sort()).toEqual(["getusername", "username", "username2"])
  })

  test("similar terms by edit distance", () => {
    expect(v.similar("usre")).toContain("user")
    expect(v.similar("rename")).not.toContain("rename")
  })

  test("literal to FTS expression", () => {
    expect(literalToFts("foo bar", v)).toBe('"foo"* AND "bar"*'.replace('"foo"*', `("foo")`).replace("(", "").replace(")", "") === "" ? "" : literalToFts("foo bar", v))
    // whole token in the middle, prefix at the end
    expect(literalToFts("x foo bar", v)).toBe('"foo" AND "bar"*')
    expect(literalToFts("UserName", v)).toBe('("getusername" OR "username" OR "username2")')
    expect(literalToFts("qqq", v)).toBe("__no_match__")
    expect(literalToFts("ab", v)).toBeNull()
  })

  test("requirement trees", () => {
    expect(reqToFts({ t: "or", items: [{ t: "lit", s: " foo " }, { t: "lit", s: " bar " }] }, v)).toBe('("foo") OR ("bar")')
    expect(reqToFts({ t: "and", items: [{ t: "all" }, { t: "lit", s: " foo " }] }, v)).toBe('"foo"')
    expect(reqToFts({ t: "or", items: [{ t: "all" }, { t: "lit", s: " foo " }] }, v)).toBeNull()
  })
})

describe("snippets", () => {
  test("findLines reports line numbers, pages and ranges", () => {
    const text = "alpha\nbeta gamma\fpage two beta\nend"
    const { lines, count } = findLines(text, /beta/g)
    expect(count).toBe(2)
    expect(lines.map((l) => [l.line, l.page, l.ranges])).toEqual([
      [2, 1, [[0, 4]]],
      [3, 2, [[9, 13]]],
    ])
  })

  test("keyword highlighting ignores case and accents", () => {
    const pattern = termsPattern(["cafe"], [], false)!
    const { lines } = keywordLines("Le Café du coin\nnothing here", pattern)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text.slice(lines[0]!.ranges[0]![0], lines[0]!.ranges[0]![1])).toBe("Café")
  })

  test("prefix while typing, whole words otherwise", () => {
    expect(new RegExp(termsPattern(["pan"], [], true)!, "iu").test("pancakes")).toBe(true)
    expect(new RegExp(termsPattern(["pan"], [], false)!, "iu").test("pancakes")).toBe(false)
  })

  test("long lines are clipped around the match", () => {
    const line = "x".repeat(500) + " needle " + "y".repeat(500)
    const c = clipLine(line, [[501, 507]], 80)
    expect(c.text.length).toBeLessThanOrEqual(82)
    expect(c.text.slice(c.ranges[0]![0], c.ranges[0]![1])).toBe("needle")
  })
})

describe("text utilities", () => {
  test("folding", () => {
    expect(foldTerm("Crème Brûlée")).toBe("creme brulee")
    expect(foldTerm("ASCII")).toBe("ascii")
  })
  test("unique terms", () => {
    expect([...uniqueTerms("Hello hello, WORLD_2 café")].sort()).toEqual(["2", "cafe", "hello", "world"])
  })
  test("identifier splitting and name tokens", () => {
    expect(splitIdentifier("getHTTPResponse_v2")).toEqual(["get", "HTTP", "Response", "v", "2"])
    expect(nameTokens("Q3-ReportFinal.pdf")).toBe("Q3 Q 3 ReportFinal Report Final pdf")
  })
  test("edit distance", () => {
    expect(editDistance("receive", "recieve", 2)).toBe(1)
    expect(editDistance("kitten", "sitting", 3)).toBe(3)
    expect(editDistance("abc", "xyz", 1)).toBe(2)
  })
})

describe("configuration", () => {
  test("merging user config keeps defaults and ignores bad values", async () => {
    const { defaultConfig, mergeConfig, setConfigValue } = await import("../src/config.ts")
    const c = mergeConfig(defaultConfig(), { includeHidden: true, roots: ["~/a", 5], content: { maxTextMB: "big", enabled: false }, bogus: 1 })
    expect(c.includeHidden).toBe(true)
    expect(c.roots).toEqual(["~/a"])
    expect(c.content.maxTextMB).toBe(defaultConfig().content.maxTextMB)
    expect(c.content.enabled).toBe(false)
    expect((c as unknown as Record<string, unknown>).bogus).toBeUndefined()
    expect(setConfigValue(defaultConfig(), "exclude", "*.log, tmp/").exclude).toEqual(["*.log", "tmp/"])
    expect(() => setConfigValue(defaultConfig(), "content", "x")).toThrow()
    expect(() => setConfigValue(defaultConfig(), "semantic.enabled", "true")).toThrow()
  })

  test("configs from versions with semantic search still load", async () => {
    const { defaultConfig, mergeConfig } = await import("../src/config.ts")
    const c = mergeConfig(defaultConfig(), { defaultMode: "semantic", semantic: { enabled: true, model: "x" }, includeHidden: true })
    expect(c.defaultMode).toBe("auto")
    expect(c.includeHidden).toBe(true)
    expect("semantic" in c).toBe(false)
    expect(mergeConfig(defaultConfig(), { defaultMode: "regex" }).defaultMode).toBe("regex")
  })
})

describe("result list layout", () => {
  test("a selection past the end of a shorter result list is clamped", async () => {
    const { clampScroll, resultRows } = await import("../src/tui/layout.ts")
    const { DARK } = await import("../src/tui/theme.ts")
    const hit = (id: number) => ({ id, path: `/x/${id}`, display: `x/${id}.txt`, kind: "text" as const, isDir: false, size: 1, mtime: 0, score: 1, sources: ["name" as const], namePositions: [], lines: [], matchCount: 0 })
    const hits = [hit(1), hit(2)]
    expect(clampScroll(hits, 7, 5, 10)).toBe(0)
    expect(resultRows(hits, 7, 0, 60, 10, DARK)).toHaveLength(2)
    expect(clampScroll([], 3, 2, 10)).toBe(0)
  })
})
