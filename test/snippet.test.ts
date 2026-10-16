import { describe, expect, test } from "bun:test"
import { diacriticPattern, findLines, foldText, keywordLines, termsPattern } from "../src/search/snippet.ts"

/** keywordLines as it was: the accented pattern over the text itself, every match counted. */
function reference(text: string, pattern: string, maxLines: number, clip: boolean, maxMatches: number) {
  return findLines(text, new RegExp(diacriticPattern(pattern), "giu"), maxLines, maxMatches, Infinity, clip)
}

/** A small seeded generator, so a failure can be reproduced. */
function random(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ["cafe", "café", "CAFÉ", "cafe\u0301", "resume", "résumé", "RESUME", "the", "The", "theory", "budget", "budgets",
  "Budgeted", "e-mail", "email", "naïve", "naive", "straße", "STRASSE", "ſun", "sun", "\u212Aey", "key", "İstanbul", "istanbul",
  "ﬁle", "file", "2023", "٣", "x²", "αβγ", "中文", "𝐚bc", "abc", "😀", "øre", "ore", "æon", "Ærø", "notes", "note", "Notes:"]
const GLUE = [" ", " ", " ", "\n", "\f", "\t", ", ", ".", "-", "_", "'", "\u0301", "\u0308", "\x01", "\x02", "\ud800", "\udc00", "\u{1D167}", "中", "é", "", "/"]
const QUERY = ["cafe", "café", "resume", "the", "theory", "budget", "e-mail", "email", "naive", "naïve", "straße", "sun", "key",
  "istanbul", "file", "2023", "abc", "ore", "notes", "note", "αβγ", "x2", "budg", "th", "t", "a"]

describe("folded keyword search", () => {
  test("each character folds to at most one letter", () => {
    // A character two letters' patterns both match would make the folded form ambiguous.
    for (let c = 0; c < 0x10000; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue
      const ch = String.fromCharCode(c)
      let n = 0
      for (const x of "abcdefghijklmnopqrstuvwxyz") if (new RegExp(`^${diacriticPattern(x)}$`, "iu").test(ch)) n++
      if (n > 1) throw new Error(`U+${c.toString(16)} matches ${n} letters`)
    }
  })

  test("finds the same lines, highlights and counts as the accented pattern", () => {
    const rnd = random(20261015)
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!
    // Half the texts have no combining marks.
    const marked = /\p{M}/u
    const plainWords = WORDS.filter((w) => !marked.test(w))
    const plainGlue = GLUE.filter((g) => !marked.test(g) && !/[\ud800-\udfff]/.test(g))
    let fast = 0
    let words = 0
    for (let round = 0; round < 800; round++) {
      const parts: string[] = []
      const n = 1 + Math.floor(rnd() * 120)
      const plain = rnd() < 0.5
      for (let k = 0; k < n; k++) parts.push(pick(plain ? plainWords : WORDS), pick(plain ? plainGlue : GLUE))
      const text = parts.join("")
      const folded = foldText(text)
      expect(folded.text.length).toBe(text.length)
      for (let p = 0; p < 6; p++) {
        const query = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(QUERY))
        const phrases = rnd() < 0.2 ? [`${pick(QUERY)} ${pick(QUERY)}`] : []
        const pattern = termsPattern(query, phrases, rnd() < 0.5)
        if (!pattern) continue
        const maxLines = 1 + Math.floor(rnd() * 5)
        const maxMatches = rnd() < 0.3 ? 1 + Math.floor(rnd() * 6) : 10_000
        const clip = rnd() < 0.5
        const want = reference(text, pattern, maxLines, clip, maxMatches)
        const got = keywordLines(text, pattern, maxLines, clip, maxMatches, rnd() < 0.5 ? folded : undefined)
        if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`differs for ${JSON.stringify(pattern)} in ${JSON.stringify(text)}`)
        if (/^[a-z0-9 ]+$/.test([...query, ...phrases].join(" "))) {
          fast++
          if (!phrases.length) words++
        }
      }
    }
    expect(fast).toBeGreaterThan(500)
    expect(words).toBeGreaterThan(500)
  }, 30_000)

  test("counts words right when a combining mark lets their matches overlap", () => {
    // "note" matches before the mark in "note\u0308ſun", "notes" through it, and "sun" right after it.
    const text = "note\u0308ſun x\nnotes\nnote sun\nnote\u0301s\nnotes notes"
    const folded = foldText(text)
    for (const [words, prefix] of [[["note", "notes"], true], [["notes", "sun"], true], [["note", "notes"], false], [["sun", "notes"], false]] as const) {
      const pattern = termsPattern([...words], [], prefix)!
      for (const maxLines of [1, 2, 10]) {
        for (const f of [folded, undefined]) {
          expect(keywordLines(text, pattern, maxLines, true, 10_000, f)).toEqual(reference(text, pattern, maxLines, true, 10_000))
        }
      }
    }
  })

})
