/**
 * How the semantic index's `vectors` table holds up at scale, in a few layouts: its size, and how
 * long the indexer's "is this passage's vector stored yet?" check takes from a cold disk cache.
 *
 *   bun scripts/bench-semantic/store.ts [--vectors=100000] [--bytes=1024] [--lookups=10000] [--work=DIR]
 *       [--layouts=without-rowid,rowid-unique,without-rowid-8k]
 *
 * `--bytes` is one vector: 1,024 for Potion (512 16-bit floats), 1,536 for Granite. Cold numbers
 * need the page cache dropped between steps (`/proc/sys/vm/drop_caches`, so Linux as root); without
 * that they are warm numbers, and say so.
 */
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k!, v ?? "true"] as [string, string] }))
const VECTORS = Number(args.get("vectors") ?? 100_000)
const BYTES = Number(args.get("bytes") ?? 1024)
const LOOKUPS = Number(args.get("lookups") ?? 10_000)
const LAYOUTS = (args.get("layouts") ?? "without-rowid,rowid-unique,without-rowid-8k").split(",")
const work = args.get("work") ?? mkdtempSync(join(tmpdir(), "zsearch-store-bench-"))
mkdirSync(work, { recursive: true })

const SCHEMAS: Record<string, { pageSize: number; sql: string }> = {
  // Before: the hash is the table's key, so the whole row, vector and all, sits in the key's B-tree.
  "without-rowid": { pageSize: 4096, sql: "CREATE TABLE vectors (hash BLOB PRIMARY KEY, vec BLOB NOT NULL) WITHOUT ROWID" },
  // After: rows in a rowid table, the hashes in an index of their own.
  "rowid-unique": { pageSize: 4096, sql: "CREATE TABLE vectors (hash BLOB NOT NULL UNIQUE, vec BLOB NOT NULL)" },
  // The other way out: pages big enough for a row, for new files only.
  "without-rowid-8k": { pageSize: 8192, sql: "CREATE TABLE vectors (hash BLOB PRIMARY KEY, vec BLOB NOT NULL) WITHOUT ROWID" },
}

let canDrop = true
function dropCaches() {
  Bun.spawnSync(["sync"])
  try { writeFileSync("/proc/sys/vm/drop_caches", "3") } catch { canDrop = false }
}

function open(path: string): Database {
  const db = new Database(path, { create: true, readwrite: true, strict: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  return db
}

const hashes = Array.from({ length: VECTORS }, () => new Uint8Array(randomBytes(16)))
const vec = new Uint8Array(randomBytes(BYTES))
// Half stored, half not: a run checks new passages as well as ones it has.
const probes = Array.from({ length: LOOKUPS }, (_, i) => (i % 2 ? hashes[Math.floor(Math.random() * VECTORS)]! : new Uint8Array(randomBytes(16))))

const ms = (t: number) => Math.round(performance.now() - t)
const results: Record<string, unknown>[] = []
for (const layout of LAYOUTS) {
  const schema = SCHEMAS[layout]
  if (!schema) throw new Error(`no layout ${layout}`)
  const path = join(work, `${layout}.db`)
  for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true })
  let db = new Database(path, { create: true, readwrite: true, strict: true })
  db.exec(`PRAGMA page_size = ${schema.pageSize}`)
  db.close()
  db = open(path)
  db.exec(schema.sql)
  let t = performance.now()
  const insert = db.prepare("INSERT OR IGNORE INTO vectors(hash, vec) VALUES (?, ?)")
  // In groups, as the indexer stores them.
  for (let i = 0; i < VECTORS; i += 64) db.transaction(() => { for (let j = i; j < Math.min(VECTORS, i + 64); j++) insert.run(hashes[j]!, vec) })()
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  const insertMs = ms(t)
  db.close()
  const mb = Math.round(Bun.file(path).size / 1e5) / 10

  dropCaches()
  db = open(path)
  const has = db.prepare("SELECT 1 FROM vectors WHERE hash = ?")
  t = performance.now()
  let found = 0
  for (const h of probes) if (has.get(h)) found++
  const lookupMs = ms(t)
  db.close()

  dropCaches()
  db = open(path)
  t = performance.now()
  const all = db.query("SELECT hash, vec FROM vectors").values().length
  const loadMs = ms(t)
  db.close()

  dropCaches()
  db = open(path)
  db.exec("CREATE TABLE passages (hash BLOB NOT NULL)")
  db.exec("CREATE INDEX passages_hash ON passages(hash)")
  const keep = db.prepare("INSERT INTO passages VALUES (?)")
  db.transaction(() => { for (let i = 0; i < VECTORS; i += 10) keep.run(hashes[i]!) })()
  t = performance.now()
  db.exec("DELETE FROM vectors WHERE hash NOT IN (SELECT hash FROM passages)")
  const pruneMs = ms(t)
  db.close()

  results.push({ layout, mb, insertMs, lookupMs, perLookupUs: Math.round((lookupMs * 1000) / LOOKUPS), found, loadMs, loaded: all, pruneMs })
}

console.log(`${VECTORS} vectors of ${BYTES} bytes, ${LOOKUPS} lookups, ${canDrop ? "cold page cache" : "WARM page cache (couldn't drop it)"}`)
console.table(results)
if (!args.has("work")) rmSync(work, { recursive: true, force: true })
