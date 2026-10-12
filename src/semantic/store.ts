/**
 * The semantic index: a SQLite file of its own next to the main index (`index.semantic.db` by
 * `index.db`), so the main index's layout, size and compaction never depend on it, and turning
 * semantic search off is deleting one file.
 *
 *   vectors   one row per distinct passage text (by a hash of exactly what the model read): the
 *             same passage in two files, or in a file renamed, rebuilt or copied, is one vector.
 *   passages  which passages a file has, where they are in its text, and their hashes.
 *   files     what each file's passages were made from (its size, date and text length), and how
 *             far through them the index got: long files are finished in a second round.
 *
 * Vectors are kept as 16-bit floats (1,536 bytes for 768 dimensions), as DigUp keeps them. 8-bit
 * integers would take half that, but with the real model they changed 2.7% of the top ten results
 * (scripts/bench-semantic/quality.ts).
 */
import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"

// 2: vectors went from 8-bit integers with a scale to 16-bit floats.
const SCHEMA_VERSION = 2

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
  if (getMeta(db, "schema_version") === String(SCHEMA_VERSION)) return
  db.transaction(() => {
    for (const t of ["vectors", "passages", "files"]) db.exec(`DROP TABLE IF EXISTS ${t}`)
    db.exec("CREATE TABLE vectors (hash BLOB PRIMARY KEY, vec BLOB NOT NULL) WITHOUT ROWID")
    // start = -1: a vector of the whole file (an image).
    db.exec("CREATE TABLE passages (file INTEGER NOT NULL, n INTEGER NOT NULL, hash BLOB NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, PRIMARY KEY (file, n)) WITHOUT ROWID")
    db.exec("CREATE INDEX passages_hash ON passages(hash)")
    // upto: passages read so far (some may have no vector: text without words); total: all of them.
    db.exec("CREATE TABLE files (file INTEGER PRIMARY KEY, sig TEXT NOT NULL, upto INTEGER NOT NULL, total INTEGER NOT NULL, note TEXT)")
    db.exec("DELETE FROM meta")
    setMeta(db, "schema_version", String(SCHEMA_VERSION))
  })()
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
