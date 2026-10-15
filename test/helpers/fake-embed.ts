/**
 * A stand-in for `zsearch-embed` (native/embed) that speaks its protocol with made-up vectors:
 * each word counts toward a dimension picked by its "concept", and a few words share one, so
 * "car" and "automobile" mean the same here and tests can tell semantic search from search by
 * words. Every request is logged to $FAKE_EMBED_LOG (one JSON line), for tests to count work.
 */
import { appendFileSync } from "node:fs"

const DIM = 1024
const CONCEPTS: Record<string, string> = {
  car: "vehicle", automobile: "vehicle", vehicle: "vehicle", sedan: "vehicle",
  invoice: "bill", bill: "bill", receipt: "bill", payment: "bill",
  dog: "pet", puppy: "pet", canine: "pet",
  holiday: "trip", vacation: "trip", trip: "trip", travel: "trip",
  sunset: "sunset", beach: "sunset",
}

function dimOf(word: string): number {
  const w = CONCEPTS[word] ?? word
  let h = 2166136261
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619)
  return (h >>> 0) % DIM
}

function vectorOf(text: string): Float32Array {
  const body = text.replace(/^.*?\| (?:text|query): /, "")
  const v = new Float32Array(DIM)
  for (const w of body.toLowerCase().match(/[a-z]+/g) ?? []) v[dimOf(w)]! += w.length > 3 ? 1 : 0.2
  // A little of everything, so no vector is all zeros.
  for (let i = 0; i < DIM; i++) v[i]! += 0.01
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n)
  return v.map((x) => x / n)
}

if (process.argv.includes("--version")) {
  console.log("zsearch-embed vectors 1")
  process.exit(0)
}
const log = process.env.FAKE_EMBED_LOG
const note = (o: object) => { if (log) appendFileSync(log, JSON.stringify(o) + "\n") }

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const send = (parts: Buffer[]) => {
  const body = Buffer.concat(parts)
  process.stdout.write(Buffer.concat([u32(body.length), body]))
}
const floats = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength)

let buf = Buffer.alloc(0)
for await (const chunk of Bun.stdin.stream()) {
  buf = Buffer.concat([buf, Buffer.from(chunk)])
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const len = buf.readUInt32LE(0)
    const msg = buf.subarray(4, 4 + len)
    buf = buf.subarray(4 + len)
    const op = String.fromCharCode(msg[0]!)
    if (op === "q") process.exit(0)
    if (op === "i") {
      const json = Buffer.from(JSON.stringify({ dim: DIM, images: true, vectorVersion: 1, batchTokens: 2048, maxSeqs: 64, maxInput: 2048 }))
      send([Buffer.from([0]), u32(json.length), json])
    } else if (op === "t") {
      const n = msg.readUInt32LE(1)
      let pos = 5
      const texts: string[] = []
      for (let i = 0; i < n; i++) {
        const l = msg.readUInt32LE(pos)
        texts.push(msg.subarray(pos + 4, pos + 4 + l).toString("utf8"))
        pos += 4 + l
      }
      note({ op: "t", n, texts })
      // A helper that never answers, until it is killed.
      if (texts.some((t) => t.includes("HANG_EMBED"))) continue
      if (texts.some((t) => t.includes("FAIL_EMBED"))) {
        const e = Buffer.from("made to fail")
        send([Buffer.from([1]), u32(e.length), e])
        continue
      }
      send([Buffer.from([0]), u32(n), u32(DIM), u32(n * 10), ...texts.map((t) => floats(vectorOf(t)))])
    }
  }
}
