/**
 * A stand-in for Potion where it can't be downloaded: a static model of word vectors from a text
 * file of "word [row] v1 v2 …" lines, which, like Potion, averages its words' vectors (weighted,
 * centred and normalized).
 */
import { readFileSync } from "node:fs"
import type { TextEmbedder } from "../../src/semantic/helper.ts"
import { normalize, preTokenize } from "../../src/semantic/potion.ts"

/** Common words a static model's own weights make all but silent. */
const STOP = new Set("a an the of in on at to for with and or my me i is was are were be it its this that these those from by as do does did how what when where which who why much many there their our your his her he she they we you".split(" "))

/** A static model of word vectors: the weighted average of the text's words' vectors, centred and normalized. */
export class WordVectors implements TextEmbedder {
  private vectors = new Map<string, Float32Array>()
  private mean: Float32Array
  constructor(path: string) {
    let dim = 0
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const parts = line.split(" ")
      if (parts.length < 10) continue
      // "word [row] v1 v2 …": a row number, when there is one, is skipped.
      const nums = parts.slice(1).map(Number)
      const v = Float32Array.from(nums.length % 2 === 1 ? nums.slice(1) : nums)
      dim = v.length
      this.vectors.set(parts[0]!, v)
    }
    this.mean = new Float32Array(dim)
    for (const v of this.vectors.values()) for (let d = 0; d < dim; d++) this.mean[d]! += v[d]! / this.vectors.size
  }
  async embedTexts(texts: string[]) {
    const dim = this.mean.length
    const out = new Float32Array(texts.length * dim)
    let tokens = 0
    texts.forEach((t, i) => {
      const o = out.subarray(i * dim, (i + 1) * dim)
      for (const w of preTokenize(normalize(t)).slice(0, 512)) {
        const v = this.vectors.get(w)
        if (!v) continue
        tokens++
        const weight = STOP.has(w) ? 0.15 : 1
        for (let d = 0; d < dim; d++) o[d]! += (v[d]! - this.mean[d]!) * weight
      }
      let n = 0
      for (const x of o) n += x * x
      if (n > 0) for (let d = 0; d < dim; d++) o[d]! /= Math.sqrt(n)
    })
    return { vectors: out, dim, tokens }
  }
  close() {}
  kill() {}
}

