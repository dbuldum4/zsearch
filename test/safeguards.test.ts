import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Config } from "../src/config.ts"
import { compressText, ContentState, indexStats, openDb } from "../src/index/db.ts"
import { datasetFolders, machineNamed } from "../src/index/datasets.ts"
import { combine, describeEstimate, estimateFolder, firstPassSeconds, roughDuration } from "../src/index/estimate.ts"
import { Indexer, type IndexProgress } from "../src/index/indexer.ts"
import { linuxPowerState, pauseReason, pmsetHot, pmsetLowPower, pmsetOnBattery, PowerGate } from "../src/index/power.ts"
import { holdsPrivateKey, secretFile } from "../src/index/secrets.ts"
import { ftsBody } from "../src/util/text.ts"
import { homeConfig, makeCorpus } from "./helpers/corpus.ts"

let corpus: ReturnType<typeof makeCorpus>
let scratch: string
const env = { HOME: process.env.HOME, ZSEARCH_HOME: process.env.ZSEARCH_HOME, ZSEARCH_OCR: process.env.ZSEARCH_OCR }

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU zebrakeymaterial\n-----END OPENSSH PRIVATE KEY-----\n"

beforeAll(() => {
  corpus = makeCorpus()
  scratch = mkdtempSync(join(tmpdir(), "zsearch-safeguards-"))
  process.env.HOME = corpus.home
  process.env.ZSEARCH_HOME = join(corpus.home, ".zsearch-data")
  // No OCR unless a test asks for it: the real helper exists only on Macs with the app.
  process.env.ZSEARCH_OCR = "0"
})

afterAll(() => {
  corpus.cleanup()
  rmSync(scratch, { recursive: true, force: true })
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const config = (patch: Partial<Config> = {}): Config => ({ ...homeConfig(), indexLoad: 100, ...patch })
const index = (db: Database, c: Config = config(), opts: { onProgress?: (p: IndexProgress) => void; power?: PowerGate } = {}) => new Indexer(db, c, { inProcess: true, ...opts }).run()
const ftsCount = (db: Database, q: string) => (db.query("SELECT count(*) AS n FROM fts WHERE fts MATCH ?").get(q) as { n: number }).n
const row = (db: Database, rel: string) => db.query("SELECT id, content_state AS state, note FROM files WHERE path = ?").get(join(corpus.home, rel)) as { id: number; state: number; note: string | null } | null

describe("keys and password files", () => {
  test("are recognised by name, wherever they are", () => {
    for (const p of ["/u/Downloads/id_rsa", "/u/Downloads/id_ed25519.pub", "/u/certs/server.pem", "/u/AuthKey_AB12CD.p8", "/u/app/prod.env", "/u/app/.env", "/u/app/.env.local", "/u/.npmrc", "/u/.netrc", "/u/app/secrets.yaml", "/u/credentials.json", "/u/client_secret_123.apps.json", "/u/vault.kdbx", "/u/.ssh/config", "/u/.aws/config", "/u/cert.p12"])
      expect([p, secretFile(p)]).toEqual([p, true])
    for (const p of ["/u/talks/launch.key", "/u/notes/secret-recipe.txt", "/u/app/environment.yml", "/u/notes/todo.md", "/u/code/keys.ts", "/u/Documents/credentials-policy.docx", "/u/envelope.txt"])
      expect([p, secretFile(p)]).toEqual([p, false])
  })

  test("and by a private key block in their text", () => {
    expect(holdsPrivateKey(KEY)).toBe(true)
    expect(holdsPrivateKey("x\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n")).toBe(true)
    expect(holdsPrivateKey("-----BEGIN PGP PRIVATE KEY BLOCK-----\n")).toBe(true)
    expect(holdsPrivateKey("PuTTY-User-Key-File-3: ssh-ed25519\n")).toBe(true)
    expect(holdsPrivateKey("-----BEGIN PUBLIC KEY-----\nMIIB\n")).toBe(false)
    expect(holdsPrivateKey("The private key must stay on the server.")).toBe(false)
  })

  test("are indexed by name only, and their text never reaches the index", async () => {
    corpus.write("Downloads/id_rsa", KEY)
    corpus.write("Downloads/server.pem", "-----BEGIN CERTIFICATE-----\nquokkacertificate\n")
    corpus.write("projects/api/prod.env", "API_TOKEN=wombattoken42\n")
    corpus.write("notes/pasted.txt", `my key\n${KEY}`)
    const db = openDb(":memory:")
    await index(db)
    for (const rel of ["Downloads/id_rsa", "Downloads/server.pem", "projects/api/prod.env", "notes/pasted.txt"]) {
      const r = row(db, rel)
      expect([rel, r?.state, r?.note]).toEqual([rel, ContentState.Skipped, "secret"])
      expect(db.query("SELECT 1 FROM content WHERE id = ?").get(r!.id)).toBeNull()
    }
    expect(ftsCount(db, "body:zebrakeymaterial OR body:quokkacertificate OR body:wombattoken42")).toBe(0)
    // Still found by name.
    expect(ftsCount(db, "name:prod AND name:env")).toBe(1)
    expect(indexStats(db).secrets).toBe(4)
    expect(row(db, "notes/todo.md")?.state).toBe(ContentState.Indexed)
    db.close()
  })

  test("indexed by an earlier version lose their text on the next run", async () => {
    corpus.write("notes/old-key.txt", KEY)
    const db = openDb(":memory:")
    await index(db)
    // As an older version left it: the key's text indexed, and no sweep done yet.
    const { id } = row(db, "notes/old-key.txt")!
    db.query("DELETE FROM fts WHERE rowid = ?").run(id)
    db.query("INSERT INTO fts(rowid, name, dirs, body) VALUES (?, 'old key txt', '', ?)").run(id, ftsBody(KEY))
    db.query("INSERT OR REPLACE INTO content(id, data) VALUES (?, ?)").run(id, compressText(KEY))
    db.query("UPDATE files SET content_state = ?, note = NULL WHERE id = ?").run(ContentState.Indexed, id)
    db.query("DELETE FROM meta WHERE key = 'secrets_swept'").run()
    expect(ftsCount(db, "body:zebrakeymaterial")).toBe(1)
    await index(db)
    expect(row(db, "notes/old-key.txt")).toMatchObject({ state: ContentState.Skipped, note: "secret" })
    expect(ftsCount(db, "body:zebrakeymaterial")).toBe(0)
    expect(db.query("SELECT 1 FROM content WHERE id = ?").get(id)).toBeNull()
    db.close()
  })
})

describe("dataset folders", () => {
  test("machine-made names, but not cameras', phones' or scanners'", () => {
    for (const n of ["000123.png", "frame_000123.jpg", "n01440764_10026.JPEG", "cat.1234.jpg", "3f2504e0-4f89-11d3-9a0c-0305e82c3301.png", "d41d8cd98f00b204e9800998ecf8427e.png", "20231005_123456.jpg"])
      expect([n, machineNamed(n)]).toEqual([n, true])
    for (const n of ["IMG_1234.JPG", "DSC01234.jpg", "PXL_20240101_101010.jpg", "Screenshot 2024-05-01 at 10.00.00.png", "scan0001.tif", "page_001.png", "holiday.jpg", "logo-v2.png", "cat.123.jpg"])
      expect([n, machineNamed(n)]).toEqual([n, false])
  })

  test("are folders of hundreds of mostly machine-named images, other than the indexed folders", () => {
    const paths: string[] = []
    for (let i = 0; i < 300; i++) paths.push(`/u/Downloads/ds/frame_${String(i).padStart(6, "0")}.png`)
    for (let i = 0; i < 400; i++) paths.push(`/u/Pictures/trip/IMG_${1000 + i}.JPG`)
    for (let i = 0; i < 299; i++) paths.push(`/u/Downloads/small/${100000 + i}.png`)
    for (let i = 0; i < 300; i++) paths.push(`/u/Downloads/${100000 + i}.png`)
    // 70% machine-named at least.
    for (let i = 0; i < 200; i++) paths.push(`/u/Downloads/mixed/${100000 + i}.png`, `/u/Downloads/mixed/holiday ${i}.png`)
    expect(datasetFolders(paths, ["/u/Downloads"])).toEqual([{ dir: "/u/Downloads/ds", images: 300 }])
  })

  test("are left out of OCR, and read again once the setting is off", async () => {
    const ocr = join(scratch, "zsearch-ocr")
    writeFileSync(ocr, `#!/bin/sh\necho "ocr text from $(basename "$2")"\n`)
    chmodSync(ocr, 0o755)
    process.env.ZSEARCH_OCR = ocr
    try {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
      for (let i = 0; i < 300; i++) corpus.write(`Downloads/dataset/frame_${String(i).padStart(6, "0")}.png`, png)
      corpus.write("notes/receipt.png", png)
      const db = openDb(":memory:")
      await index(db)
      expect(row(db, "Downloads/dataset/frame_000007.png")).toMatchObject({ state: ContentState.Skipped, note: "dataset" })
      expect(row(db, "notes/receipt.png")?.state).toBe(ContentState.Indexed)
      const stats = indexStats(db)
      expect(stats.datasetImages).toBe(300)
      expect(stats.datasetFolders).toEqual([{ dir: join(corpus.home, "Downloads/dataset"), images: 300 }])
      expect(ftsCount(db, "name:frame")).toBeGreaterThanOrEqual(300)

      await index(db, config({ skipDatasetOcr: false }))
      expect(row(db, "Downloads/dataset/frame_000007.png")?.state).toBe(ContentState.Indexed)
      expect(indexStats(db).datasetImages).toBe(0)
      db.close()
    } finally {
      process.env.ZSEARCH_OCR = "0"
      rmSync(join(corpus.home, "Downloads/dataset"), { recursive: true, force: true })
      rmSync(join(corpus.home, "notes/receipt.png"), { force: true })
    }
  })
})

describe("power", () => {
  test("reads macOS's pmset", () => {
    expect(pmsetOnBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging")).toBe(true)
    expect(pmsetOnBattery("Now drawing from 'AC Power'\n")).toBe(false)
    expect(pmsetLowPower("System-wide power settings:\nCurrently in use:\n standby              1\n lowpowermode         1\n")).toBe(true)
    expect(pmsetLowPower(" lowpowermode         0\n powernap 1\n")).toBe(false)
    expect(pmsetHot("CPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= 62\n")).toBe(true)
    expect(pmsetHot("Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\n")).toBe(false)
    expect(pmsetHot("CPU_Speed_Limit \t= 100\n")).toBe(false)
  })

  test("reads Linux's /sys", () => {
    const sys = join(scratch, "sys")
    mkdirSync(join(sys, "class/power_supply/BAT0"), { recursive: true })
    mkdirSync(join(sys, "firmware/acpi"), { recursive: true })
    writeFileSync(join(sys, "class/power_supply/BAT0/type"), "Battery\n")
    writeFileSync(join(sys, "class/power_supply/BAT0/status"), "Discharging\n")
    writeFileSync(join(sys, "firmware/acpi/platform_profile"), "low-power\n")
    expect(linuxPowerState(sys)).toEqual({ lowPower: true, hot: false, battery: true })
    writeFileSync(join(sys, "class/power_supply/BAT0/status"), "Charging\n")
    writeFileSync(join(sys, "firmware/acpi/platform_profile"), "balanced\n")
    expect(linuxPowerState(sys)).toEqual({ lowPower: false, hot: false, battery: false })
    expect(linuxPowerState(join(scratch, "nothing-here"))).toEqual({ lowPower: false, hot: false, battery: false })
  })

  test("waits in Low Power Mode and heat, and on battery only when asked", () => {
    const calm = { lowPower: false, hot: false, battery: false }
    const defaults = { pauseOnLowPower: true, pauseOnBattery: false }
    expect(pauseReason(calm, defaults)).toBeNull()
    expect(pauseReason({ ...calm, lowPower: true }, defaults)).toBe("Low Power Mode")
    expect(pauseReason({ ...calm, hot: true }, defaults)).toBe("the computer is hot")
    expect(pauseReason({ ...calm, battery: true }, defaults)).toBeNull()
    expect(pauseReason({ ...calm, battery: true }, { ...defaults, pauseOnBattery: true })).toBe("on battery")
    expect(pauseReason({ ...calm, lowPower: true }, { pauseOnLowPower: false, pauseOnBattery: false })).toBeNull()
  })

  test("reads the state at most every half a minute, with the settings", () => {
    let t = 0, reads = 0
    let settings = { pauseOnLowPower: true, pauseOnBattery: false }
    const gate = new PowerGate(() => settings, () => { reads++; return { lowPower: true, hot: false, battery: false } }, () => t)
    expect(gate.reason()).toBe("Low Power Mode")
    t = 10_000
    expect(gate.reason()).toBe("Low Power Mode")
    expect(reads).toBe(1)
    settings = { pauseOnLowPower: false, pauseOnBattery: false }
    t = 30_000
    expect(gate.reason()).toBeNull()
    // With pausing off, the state is not read at all.
    expect(reads).toBe(1)
  })

  test("a big pass waits before reading contents, then goes on", async () => {
    for (let i = 0; i < 1100; i++) corpus.write(`bulk/file-${i}.txt`, `bulk word number${i}\n`)
    try {
      let calls = 0
      const gate = { reason: () => (++calls <= 3 ? "Low Power Mode" : null) } as unknown as PowerGate
      const seen: IndexProgress[] = []
      const db = openDb(":memory:")
      const done = await index(db, config(), { power: gate, onProgress: (p) => seen.push(p) })
      expect(done.phase).toBe("done")
      const waiting = seen.filter((p) => p.waiting === "Low Power Mode")
      expect(waiting.length).toBeGreaterThan(0)
      expect(waiting.every((p) => p.contentDone === 0)).toBe(true)
      expect(seen.at(-1)!.waiting).toBeUndefined()
      expect(ftsCount(db, "body:number1099")).toBe(1)
      db.close()
    } finally {
      rmSync(join(corpus.home, "bulk"), { recursive: true, force: true })
    }
  })

  test("a small pass does not wait", async () => {
    const gate = { reason: () => "Low Power Mode" } as unknown as PowerGate
    const db = openDb(":memory:")
    const done = await index(db, config(), { power: gate })
    expect(done.phase).toBe("done")
    expect(done.waiting).toBeUndefined()
    db.close()
  })
})

describe("first index estimates", () => {
  test("count what a first pass reads, without opening anything", () => {
    corpus.write("Downloads/id_dsa", KEY)
    const e = estimateFolder(corpus.home, config())
    expect(e.complete).toBe(true)
    expect(e.files).toBeGreaterThan(10)
    expect(e.documents).toBeGreaterThan(0)
    expect(e.textFiles).toBeGreaterThan(0)
    expect(e.ocrImages).toBe(0)
    expect(e.seconds).toBeGreaterThan(0)
    // Names only: no contents to read, so only the walk counts.
    const names = estimateFolder(corpus.home, config({ content: { ...config().content, enabled: false } }))
    expect(names.files).toBe(e.files)
    expect(names.textFiles + names.documents).toBe(0)
    expect(names.seconds).toBeLessThan(e.seconds)
  })

  test("give a lower bound when the walk runs out of time", () => {
    for (let i = 0; i < 1100; i++) corpus.write(`many/f${i}.txt`, "x")
    try {
      let t = 0
      const e = estimateFolder(corpus.home, config(), 1000, () => (t += 2000))
      expect(e.complete).toBe(false)
      expect(describeEstimate(e)).toStartWith("over ")
    } finally {
      rmSync(join(corpus.home, "many"), { recursive: true, force: true })
    }
  })

  test("in words", () => {
    expect(roughDuration(20)).toBe("under a minute")
    expect(roughDuration(80)).toBe("about a minute")
    expect(roughDuration(600)).toBe("about 10 minutes")
    expect(roughDuration(3700)).toBe("about an hour")
    expect(roughDuration(9000)).toBe("about 2.5 hours")
    const one = { root: "~/A", files: 12_345, folders: 10, textFiles: 1, textBytes: 1, documents: 1, ocrImages: 0, complete: true, seconds: 600 }
    expect(describeEstimate(one)).toBe("12,345 files · about 10 minutes")
    const both = combine([one, { ...one, root: "~/B", complete: false }])
    expect(both).toMatchObject({ root: "~/A, ~/B", files: 24_690, seconds: 1200, complete: false })
    expect(describeEstimate(both)).toBe("over 24,690 files · at least 20 minutes")
  })

  test("OCR costs most, and more workers help", () => {
    const counts = { files: 1000, folders: 10, textFiles: 1000, textBytes: 10 * 1024 * 1024, documents: 0, ocrImages: 0 }
    expect(firstPassSeconds({ ...counts, ocrImages: 1000 }, 4)).toBeGreaterThan(firstPassSeconds({ ...counts, documents: 1000 }, 4))
    expect(firstPassSeconds(counts, 8)).toBeLessThan(firstPassSeconds(counts, 1))
  })
})
