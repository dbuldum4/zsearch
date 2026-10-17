import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { join } from "node:path"
import { openDb } from "../src/index/db.ts"
import { Indexer } from "../src/index/indexer.ts"
import { SearchEngine, type SearchResponse } from "../src/search/engine.ts"
import type { Mode } from "../src/search/query.ts"
import { literalRequirement, regexRequirements, type Req } from "../src/search/regex-plan.ts"
import { byteTerms } from "../src/index/byte-terms.ts"
import { indexTerms, MAX_TERM, uniqueTerms } from "../src/util/text.ts"
import { makeCorpus, homeConfig } from "./helpers/corpus.ts"

let corpus: ReturnType<typeof makeCorpus>
let db: Database
let engine: SearchEngine
const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME }

beforeAll(async () => {
  corpus = makeCorpus()
  process.env.HOME = corpus.home
  process.env.ZSEARCH_HOME = join(corpus.home, ".zsearch-data")
  corpus.write("notes/nested.txt", "the foobar then baz\n")
  corpus.write("notes/repeated.txt", "foo one barfoo two bar\n")
  corpus.write("notes/greek.txt", "ο κόσμος είναι μεγάλος\n")
  corpus.write("notes/micro.txt", "a length of 5μm\n")
  corpus.write("notes/capitals.txt", "ΟΣΑ ΞΕΡΩ\n")
  corpus.write("notes/long-word.txt", `start ${"q".repeat(90)} end\n`)
  db = openDb(join(corpus.home, ".zsearch-data", "index.db"))
  await new Indexer(db, homeConfig(), { inProcess: true }).run()
  engine = new SearchEngine(db, homeConfig())
})

afterAll(() => {
  db.close()
  corpus.cleanup()
  process.env.HOME = env.HOME
  if (env.ZSEARCH_HOME === undefined) delete process.env.ZSEARCH_HOME
  else process.env.ZSEARCH_HOME = env.ZSEARCH_HOME
})

const search = (q: string, mode: Mode = "find") => engine.search(q, mode, { limit: 50 })
const names = (r: SearchResponse) => r.hits.map((h) => h.display)
const flat = (r: Req): unknown => (r.t === "lit" ? r.s : r.t === "all" ? "*" : { [r.t]: r.items.map(flat) })

describe("nested regexes keep the parts they cannot pin down", () => {
  test("a group with a wildcard is not an exact string", () => {
    expect(flat(regexRequirements("foo(bar.*baz)", false))).toEqual({ and: ["foo", "bar", "baz"] })
    expect(flat(regexRequirements("(foo.*bar){2}", false))).toEqual({ and: ["foo", "bar"] })
    expect(flat(regexRequirements("x(ab|cd.*ef)y", false))).toEqual({ or: ["ab", { and: ["cd", "ef"] }] })
    // Too many combinations to list: the inner sequence is not one of its last part's strings.
    expect(flat(regexRequirements("x((ab|cd|ef|gh|ij)(kl|mn|op|qr))", false))).toEqual({ and: [{ or: ["ab", "cd", "ef", "gh", "ij"] }, { or: ["kl", "mn", "op", "qr"] }] })
  })

  test("finds the files the regex matches", async () => {
    const r = await search("/foo(bar.*baz)/")
    expect(names(r)).toEqual(["notes/nested.txt"])
    expect(r.partial).toBe(false)
    const r2 = await search("/(foo.*bar){2}/")
    expect(names(r2)).toEqual(["notes/repeated.txt"])
    expect(r2.partial).toBe(false)
  })
})

describe("words over 64 characters", () => {
  test("are found whole and by any part", async () => {
    expect(names(await search("q".repeat(90)))).toEqual(["notes/long-word.txt"])
    expect(names(await search("q".repeat(70)))).toEqual(["notes/long-word.txt"])
    expect(names(await search("qqq"))).toEqual(["notes/long-word.txt"])
    expect(names(await search("/q{80}/"))).toEqual(["notes/long-word.txt"])
  })

  test("runs longer than MAX_TERM stay out of the vocabulary", () => {
    const text = `bytecode ${"a1".repeat(MAX_TERM)} end`
    expect([...uniqueTerms(text)]).toEqual(["bytecode", "end"])
    expect([...indexTerms(text).terms]).toEqual(["bytecode", "end"])
    expect(byteTerms(new TextEncoder().encode(text), "max-term-test")!.report()).toEqual(["bytecode", "end"])
    expect([...indexTerms(`x ${"b".repeat(MAX_TERM)} y`).terms]).toContain("b".repeat(MAX_TERM))
  })
})

describe("prefilters follow the regex's case equivalence", () => {
  test("letters with more than one lower-case form become alternatives", () => {
    expect(flat(regexRequirements("ΣΑ", true))).toEqual({ or: ["σα", "ςα"] })
    expect(flat(literalRequirement("σα", true))).toEqual({ or: ["σα", "ςα"] })
    expect(flat(regexRequirements("Hello", true))).toBe("hello")
    expect(flat(regexRequirements("Café", true))).toBe("café")
  })

  test("a Greek word in capitals finds it with a final sigma", async () => {
    expect(new RegExp("ΚΌΣΜΟΣ", "i").test("κόσμος")).toBe(true)
    expect(names(await search("/ΚΌΣΜΟΣ/i"))).toEqual(["notes/greek.txt"])
    expect(names(await search("κόσμοσ"))).toEqual(["notes/greek.txt"])
  })

  test("a capital sigma matches where the index has either lower-case form", async () => {
    expect(flat(regexRequirements("ΟΣ", false))).toEqual({ or: ["Οσ", "Ος"] })
    expect(names(await search("/ΟΣ/"))).toEqual(["notes/capitals.txt"])
    expect(names(await search("ΟΣ"))).toEqual(["notes/capitals.txt"])
  })

  test("the micro sign finds the Greek letter mu", async () => {
    expect(new RegExp("5µm", "i").test("5μm")).toBe(true)
    expect(names(await search("/5µm/i"))).toEqual(["notes/micro.txt"])
  })
})
