/**
 * The Granite semantic index is a separate SQLite file (`index.semantic.db`, by
 * `index.db`), so the main index's layout, size and compaction never depend on it.
 * Turning semantic search off removes the semantic index and its model.
 *
 *   vectors   one row per distinct passage text (by a hash of exactly what the model read): the
 *             same passage in two files, or in a file renamed, rebuilt or copied, is one vector.
 *   passages  which passages a file has, where they are in its text, and their hashes.
 *   files     what each file's passages were made from (its size, date, text length and text hash), and how
 *             far through them the index got: long files are finished in a second round.
 *
 * Vectors are kept as 16-bit floats (768 bytes for Granite's 384 dimensions), as DigUp keeps them. 8-bit
 * integers would take half that, but with the real model they changed 2.7% of the top ten results
 * (scripts/bench-semantic/quality.ts).
 *
 * `vectors` is a rowid table with its hashes in an index of their own, not a WITHOUT ROWID table
 * keyed by hash: there, a row is kept whole in the key's B-tree, and a row of 1 KB or more (older float32
 * vectors) is more than a 4 KB page keeps in place, so each one spilled onto
 * a page of its own. At 100k vectors that made the file 3.4x the size, and checking whether a
 * passage's vector is stored read those pages: 33x slower from a cold disk cache
 * (scripts/bench-semantic/store.ts).
 */
import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"

// 2: vectors went from 8-bit integers with a scale to 16-bit floats.
// 3: vectors became a rowid table; version 2's are copied over (`migrate`).
const SCHEMA_VERSION = 3

const VECTORS_TABLE = "(hash BLOB NOT NULL UNIQUE, vec BLOB NOT NULL)"

export function semanticDbPath(dbPath: string): string {
  if (dbPath === ":memory:") return ":memory:"
  return join(dirname(dbPath), `${basename(dbPath).replace(/\.db$/, "")}.semantic.db`)
}

export function openSemanticDb(path: string, opts: { readonly?: boolean } = {}): Database | null {
  if (opts.readonly && path !== ":memory:" && !existsSync(path)) return null
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path, { create: !opts.readonly, readwrite: true, strict: true })
  if (path !== ":memory:") chmodSync(path, 0o600)
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  if (!opts.readonly) migrate(db)
  return db
}

function migrate(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const version = getMeta(db, "schema_version")
  if (version === String(SCHEMA_VERSION)) return
  if (version === "2") {
    // Only the vectors table changed: copy it, so no vector has to be made again (Granite's take hours).
    // The old table's vectors are scattered over the file, one page each: read through a memory map,
    // the system reads ahead around each one, and the copy and VACUUM take a third of the time
    // (1.2 GB of vectors: 21 s to 6.6 s from a cold disk cache).
    db.exec("PRAGMA mmap_size = 2147418112")
    try {
      db.transaction(() => {
        if (getMeta(db, "schema_version") !== "2") return
        db.exec(`CREATE TABLE vectors_new ${VECTORS_TABLE}`)
        db.exec("INSERT INTO vectors_new(hash, vec) SELECT hash, vec FROM vectors")
        db.exec("DROP TABLE vectors")
        db.exec("ALTER TABLE vectors_new RENAME TO vectors")
        setMeta(db, "schema_version", String(SCHEMA_VERSION))
      })()
      // Give back the old table's pages: it was about 3x the size of the new one.
      try {
        db.exec("VACUUM")
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      } catch {}
    } finally {
      db.exec("PRAGMA mmap_size = 0")
    }
    return
  }
  db.transaction(() => {
    for (const t of ["vectors", "passages", "files"]) db.exec(`DROP TABLE IF EXISTS ${t}`)
    db.exec(`CREATE TABLE vectors ${VECTORS_TABLE}`)
    // start = -1: a vector of the whole file (an image).
    db.exec("CREATE TABLE passages (file INTEGER NOT NULL, n INTEGER NOT NULL, hash BLOB NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, PRIMARY KEY (file, n)) WITHOUT ROWID")
    db.exec("CREATE INDEX passages_hash ON passages(hash)")
    // upto: passages read so far (some may have no vector: text without words); total: all of them.
    db.exec("CREATE TABLE files (file INTEGER PRIMARY KEY, sig TEXT NOT NULL, upto INTEGER NOT NULL, total INTEGER NOT NULL, note TEXT)")
    db.exec("DELETE FROM meta")
    setMeta(db, "schema_version", String(SCHEMA_VERSION))
  })()
}

/**
 * Whether searches can read this file's vectors as they are: a read-only connection doesn't
 * migrate it. Version 2 differs from 3 only in how the vectors table is laid out.
 */
export function readableSchema(db: Database): boolean {
  const version = getMeta(db, "schema_version")
  return version === String(SCHEMA_VERSION) || version === "2"
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null
  return row?.value ?? null
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
}

/** Everything but the vectors, which a rebuilt main index (new file ids) can use again. */
export function clearPassages(db: Database): void {
  db.transaction(() => {
    db.exec("DELETE FROM passages")
    db.exec("DELETE FROM files")
  })()
}

export function clearAll(db: Database): void {
  db.transaction(() => {
    db.exec("DELETE FROM vectors")
    db.exec("DELETE FROM passages")
    db.exec("DELETE FROM files")
  })()
}

/** `dim` floats of `v` from `offset`, as 16-bit floats. */
export function packVector(v: Float32Array, offset: number, dim: number): Uint8Array {
  const h = new Float16Array(dim)
  h.set(v.subarray(offset, offset + dim))
  return new Uint8Array(h.buffer)
}

/** A stored vector as 16-bit floats, or null if it isn't `dim` long. */
export function vectorValues(vec: Uint8Array, dim: number): Float16Array | null {
  if (vec.length !== dim * 2) return null
  // SQLite's blobs may not be 2-byte aligned: copy them.
  return new Float16Array(vec.slice().buffer)
}

export interface SemanticStats {
  files: number
  passages: number
  vectors: number
  partial: number
  bytes: number
  lastRunAt: number | null
  error: string | null
}

export function semanticStats(db: Database, path?: string): SemanticStats {
  const c = db.query("SELECT (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM passages) AS passages, (SELECT COUNT(*) FROM vectors) AS vectors, (SELECT COUNT(*) FROM files WHERE upto < total) AS partial").get() as Record<string, number>
  let bytes = 0
  if (path && path !== ":memory:") for (const suffix of ["", "-wal"]) { try { bytes += Bun.file(path + suffix).size } catch {} }
  const last = getMeta(db, "last_run_at")
  return { files: c.files!, passages: c.passages!, vectors: c.vectors!, partial: c.partial!, bytes, lastRunAt: last ? Number(last) : null, error: getMeta(db, "last_error") || null }
}
