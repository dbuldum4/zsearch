import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

/** Bump when the on-disk layout or tokenisation changes; older indexes are rebuilt. */
export const SCHEMA_VERSION = 6

export const ContentState = {
  /** No content wanted (folders, media, names-only areas). */
  None: 0,
  Indexed: 1,
  Error: 2,
  /** Skipped: binary, too large, empty or unsupported. */
  Skipped: 3,
  Pending: 4,
} as const

export interface FileRow {
  id: number
  path: string
  name: string
  ext: string
  kind: string
  is_dir: number
  size: number
  mtime: number
  content_state: number
  content_len: number
  note: string | null
}

function versionAtLeast(v: string, major: number, minor: number): boolean {
  const [a = 0, b = 0] = v.split(".").map(Number)
  return a > major || (a === major && b >= minor)
}

export interface OpenOptions {
  readonly?: boolean
  /** Force the classic contentless FTS delete protocol (tests). */
  manualFtsDelete?: boolean
}

export function openDb(path: string, opts: OpenOptions = {}): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: !opts.readonly, readwrite: true, strict: true })
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA temp_store = MEMORY")
  db.exec("PRAGMA cache_size = -32000")
  if (!opts.readonly) migrate(db, opts)
  return db
}

function migrate(db: Database, opts: OpenOptions) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const version = Number(getMeta(db, "schema_version") ?? 0)
  if (version === SCHEMA_VERSION) return
  db.transaction(() => {
    // "chunks" held semantic search vectors before version 6.
    for (const t of ["fts", "fts_v", "files", "content", "chunks", "vocab"]) db.exec(`DROP TABLE IF EXISTS ${t}`)
    db.exec(`CREATE TABLE files (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      kind TEXT NOT NULL,
      is_dir INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL DEFAULT 0,
      content_state INTEGER NOT NULL DEFAULT 0,
      content_len INTEGER NOT NULL DEFAULT 0,
      in_fts INTEGER NOT NULL DEFAULT 0,
      note TEXT
    )`)
    db.exec("CREATE INDEX files_state ON files(content_state)")
    db.exec("CREATE TABLE content (id INTEGER PRIMARY KEY, data BLOB NOT NULL)")
    const sqliteVersion = (db.query("SELECT sqlite_version() AS v").get() as { v: string }).v
    const contentlessDelete = !opts.manualFtsDelete && versionAtLeast(sqliteVersion, 3, 43)
    db.exec(
      `CREATE VIRTUAL TABLE fts USING fts5(name, dirs, body, content='', ${contentlessDelete ? "contentless_delete=1, " : ""}tokenize='unicode61 remove_diacritics 2', prefix='3')`,
    )
    db.exec("CREATE TABLE vocab (id INTEGER PRIMARY KEY, term TEXT NOT NULL UNIQUE)")
    db.exec("CREATE TABLE IF NOT EXISTS frecency (path TEXT PRIMARY KEY, count INTEGER NOT NULL, last INTEGER NOT NULL)")
    db.exec("DELETE FROM meta WHERE key <> 'created_at'")
    setMeta(db, "schema_version", String(SCHEMA_VERSION))
    setMeta(db, "fts_delete", contentlessDelete ? "contentless" : "manual")
    setMeta(db, "generation", "0")
    if (!getMeta(db, "created_at")) setMeta(db, "created_at", String(Date.now()))
  })()
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null
  return row?.value ?? null
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
/** Texts below this size are stored uncompressed: per-call codec overhead would dominate. */
const COMPRESS_MIN = 8192

/** Stored text: one header byte (0 = raw UTF-8, 1 = zstd) followed by the payload. */
export function compressText(text: string): Uint8Array {
  const raw = encoder.encode(text)
  if (raw.length < COMPRESS_MIN) {
    const out = new Uint8Array(raw.length + 1)
    out.set(raw, 1)
    return out
  }
  const z = Bun.zstdCompressSync(raw, { level: 3 })
  const out = new Uint8Array(z.length + 1)
  out[0] = 1
  out.set(z, 1)
  return out
}

export function decompressText(data: Uint8Array): string {
  if (data[0] === 1) return decoder.decode(Bun.zstdDecompressSync(data.subarray(1)))
  return decoder.decode(data.subarray(1))
}

/** Read the stored (extracted) text of a file, or null. */
export function readContent(db: Database, id: number): string | null {
  const row = db.query("SELECT data FROM content WHERE id = ?").get(id) as { data: Uint8Array } | null
  return row ? decompressText(row.data) : null
}

export interface IndexStats {
  files: number
  folders: number
  withContent: number
  errors: number
  skipped: number
  pending: number
  contentBytes: number
  dbBytes: number
  lastIndexedAt: number | null
  lastDurationMs: number | null
  roots: string[]
  generation: number
}

export function indexStats(db: Database, dbPath?: string): IndexStats {
  const counts = db
    .query(
      `SELECT
        SUM(is_dir = 0) AS files, SUM(is_dir = 1) AS folders,
        SUM(content_state = 1) AS withContent, SUM(content_state = 2) AS errors,
        SUM(content_state = 3) AS skipped, SUM(content_state = 4) AS pending,
        SUM(CASE WHEN content_state = 1 THEN content_len ELSE 0 END) AS contentBytes
      FROM files`,
    )
    .get() as Record<string, number | null>
  let dbBytes = 0
  if (dbPath) {
    for (const suffix of ["", "-wal"]) {
      try {
        dbBytes += Bun.file(dbPath + suffix).size
      } catch {
        // missing WAL is fine
      }
    }
  }
  const last = getMeta(db, "last_indexed_at")
  const dur = getMeta(db, "last_duration_ms")
  return {
    files: counts.files ?? 0,
    folders: counts.folders ?? 0,
    withContent: counts.withContent ?? 0,
    errors: counts.errors ?? 0,
    skipped: counts.skipped ?? 0,
    pending: counts.pending ?? 0,
    contentBytes: counts.contentBytes ?? 0,
    dbBytes,
    lastIndexedAt: last ? Number(last) : null,
    lastDurationMs: dur ? Number(dur) : null,
    roots: JSON.parse(getMeta(db, "roots") ?? "[]"),
    generation: Number(getMeta(db, "generation") ?? 0),
  }
}
