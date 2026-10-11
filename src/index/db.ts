import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

/** Bump when the on-disk layout or tokenisation changes; older indexes are rebuilt. */
const SCHEMA_VERSION = 9

export const ContentState = {
  /** No content wanted (folders, media, names-only areas). */
  None: 0,
  Indexed: 1,
  Error: 2,
  /** Skipped: binary, too large, empty or unsupported. */
  Skipped: 3,
  Pending: 4,
} as const

/**
 * The ids of files removed from the index, in order: readers keeping the file list in memory
 * drop them from it rather than reading the whole list again. Trimmed to its last
 * REMOVED_KEPT rows; a reader that fell behind that far reads everything again.
 */
const REMOVED_TABLE = "CREATE TABLE IF NOT EXISTS removed (n INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL)"
export const REMOVED_KEPT = 100_000

function versionAtLeast(v: string, major: number, minor: number): boolean {
  const [a = 0, b = 0] = v.split(".").map(Number)
  return a > major || (a === major && b >= minor)
}

interface OpenOptions {
  readonly?: boolean
  /** Force the classic contentless FTS delete protocol (tests). */
  manualFtsDelete?: boolean
}

export function openDb(path: string, opts: OpenOptions = {}): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path, { create: !opts.readonly, readwrite: true, strict: true })
  if (path !== ":memory:") chmodSync(path, 0o600)
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA temp_store = MEMORY")
  db.exec("PRAGMA cache_size = -32000")
  if (path !== ":memory:") for (const suffix of ["-wal", "-shm"]) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600)
  if (!opts.readonly) migrate(db, opts)
  return db
}

function migrate(db: Database, opts: OpenOptions) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const version = Number(getMeta(db, "schema_version") ?? 0)
  if (version === SCHEMA_VERSION) {
    // Added after version 8 without a rebuild: older indexes get it here.
    db.exec(REMOVED_TABLE)
    return
  }
  db.transaction(() => {
    // "chunks" held semantic search vectors before version 6; "vocab" was one row per term before version 7.
    for (const t of ["fts", "fts_v", "files", "content", "chunks", "vocab", "vocab_chunks", "removed"]) db.exec(`DROP TABLE IF EXISTS ${t}`)
    db.exec(`CREATE TABLE files (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      kind TEXT NOT NULL,
      is_dir INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL DEFAULT 0,
      dev INTEGER NOT NULL DEFAULT 0,
      ino INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '',
      source_path TEXT NOT NULL DEFAULT '',
      content_state INTEGER NOT NULL DEFAULT 0,
      content_len INTEGER NOT NULL DEFAULT 0,
      in_fts INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      -- Bumped each time an existing row's metadata changes, so readers can reload just those rows.
      seq INTEGER NOT NULL DEFAULT 0
    )`)
    db.exec("CREATE INDEX files_state ON files(content_state)")
    db.exec("CREATE INDEX files_seq ON files(seq)")
    for (const [event, clause] of [["insert", "INSERT"], ["update", "UPDATE OF path, name, ext, kind, is_dir, size, mtime, created, dev, ino, metadata, source_path, content_state, content_len, note, in_fts"]]) {
      db.exec(`CREATE TRIGGER files_${event}_seq AFTER ${clause} ON files BEGIN
        INSERT INTO meta(key, value) VALUES ('change_seq', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
        UPDATE files SET seq = (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'change_seq') WHERE id = NEW.id;
      END`)
    }
    db.exec("CREATE TABLE content (id INTEGER PRIMARY KEY, data BLOB NOT NULL)")
    const sqliteVersion = (db.query("SELECT sqlite_version() AS v").get() as { v: string }).v
    const contentlessDelete = !opts.manualFtsDelete && versionAtLeast(sqliteVersion, 3, 43)
    // detail=column keeps which columns hold a term but not its positions: about a third of the
    // size of detail=full. Phrases are matched as AND of their words; exact text and regex
    // searches check every candidate against the stored text anyway. No prefix index: prefix
    // queries scan the sorted term list, which is fast enough and saves another third.
    db.exec(
      `CREATE VIRTUAL TABLE fts USING fts5(name, dirs, body, content='', ${contentlessDelete ? "contentless_delete=1, " : ""}tokenize='unicode61 remove_diacritics 2', detail=column)`,
    )
    // The content vocabulary, append-only: each row is a compressed, newline-separated batch of new terms.
    db.exec("CREATE TABLE vocab_chunks (id INTEGER PRIMARY KEY, terms BLOB NOT NULL)")
    db.exec(REMOVED_TABLE)
    db.exec("CREATE TABLE IF NOT EXISTS frecency (path TEXT PRIMARY KEY, count INTEGER NOT NULL, last INTEGER NOT NULL)")
    for (const event of ["INSERT", "UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER IF NOT EXISTS frecency_${event.toLowerCase()} AFTER ${event} ON frecency BEGIN
      INSERT INTO meta(key, value) VALUES ('frecency_seq', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
    END`)
    db.exec("DELETE FROM meta WHERE key <> 'created_at'")
    setMeta(db, "schema_version", String(SCHEMA_VERSION))
    setMeta(db, "fts_delete", contentlessDelete ? "contentless" : "manual")
    setMeta(db, "generation", "0")
    if (!getMeta(db, "created_at")) setMeta(db, "created_at", String(Date.now()))
  })()
  compact(db)
}

/** Empty the index (files, texts, vocabulary) in place, so that the next run rebuilds it. */
export function clearIndex(db: Database): void {
  db.transaction(() => {
    if (getMeta(db, "fts_delete") === "manual") {
      db.exec("DROP TABLE fts")
      db.exec("CREATE VIRTUAL TABLE fts USING fts5(name, dirs, body, content='', tokenize='unicode61 remove_diacritics 2', detail=column)")
    } else {
      db.exec("INSERT INTO fts(fts) VALUES ('delete-all')")
    }
    db.exec("DELETE FROM content")
    db.exec("DELETE FROM files")
    db.exec("DELETE FROM vocab_chunks")
    db.exec("DELETE FROM removed")
    setMeta(db, "generation", String(Number(getMeta(db, "generation") ?? 0) + 1))
  })()
  compact(db)
}

/**
 * Give the space of emptied tables back to the file system: SQLite otherwise keeps the file at
 * its largest size and only reuses the free pages. Cheap right after the tables were emptied.
 * With a reader still open the file shrinks at a later checkpoint instead.
 */
function compact(db: Database): void {
  try {
    db.exec("VACUUM")
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } catch {
    // Busy: the free pages are reused by the next writes instead.
  }
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
/**
 * Stored text: one header byte (0 = raw UTF-8, 1 = zstd, 2 = deflate) followed by the payload.
 * Searches decompress every candidate, and both codecs cost tens of microseconds per call, so
 * small texts stay raw, mid-sized ones use deflate (cheapest per call) and large ones zstd
 * (fastest per byte). On a mixed corpus this stores about half the bytes of raw text.
 * Deflate's level 1 compresses about twice as fast as level 4, for texts about a fifth larger.
 */
const RAW_BELOW = 1024
const ZSTD_FROM = 16 * 1024

function withHeader(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1)
  out[0] = kind
  out.set(payload, 1)
  return out
}

export function compressText(text: string): Uint8Array {
  return compressBytes(encoder.encode(text))
}

/** `compressText` of the text these UTF-8 bytes hold. */
export function compressBytes(raw: Uint8Array<ArrayBuffer>): Uint8Array {
  if (raw.length >= RAW_BELOW) {
    const z = raw.length >= ZSTD_FROM ? Bun.zstdCompressSync(raw, { level: 3 }) : Bun.deflateSync(raw, { level: 1 })
    if (z.length < raw.length) return withHeader(raw.length >= ZSTD_FROM ? 1 : 2, z)
  }
  return withHeader(0, raw)
}

export function decompressText(data: Uint8Array): string {
  const body = data.subarray(1)
  if (data[0] === 1) return decoder.decode(Bun.zstdDecompressSync(body))
  if (data[0] === 2) return decoder.decode(Bun.inflateSync(body as Uint8Array<ArrayBuffer>))
  return decoder.decode(body)
}

/** Vocabulary chunks with an id above `afterId`, oldest first: each is a list of new terms. */
export function readVocabChunks(db: Database, afterId = 0): { id: number; terms: string[] }[] {
  const rows = db.query("SELECT id, terms FROM vocab_chunks WHERE id > ? ORDER BY id").all(afterId) as { id: number; terms: Uint8Array }[]
  return rows.map((r) => ({ id: r.id, terms: decompressText(r.terms).split("\n") }))
}

/** Every term in the vocabulary. */
export function loadVocabTerms(db: Database): Set<string> {
  const out = new Set<string>()
  for (const c of readVocabChunks(db)) for (const t of c.terms) out.add(t)
  return out
}

/** Read the stored (extracted) text of a file, or null. */
export function readContent(db: Database, id: number): string | null {
  const row = db.query("SELECT data FROM content WHERE id = ?").get(id) as { data: Uint8Array } | null
  return row ? decompressText(row.data) : null
}

export interface IndexStats {
  unreadableFolders?: string[]
  files: number
  folders: number
  withContent: number
  errors: number
  skipped: number
  pending: number
  /** Keys and password files, indexed by name only (see `secrets.ts`). */
  secrets: number
  /** Images OCR left out, in machine-made dataset folders (see `datasets.ts`). */
  datasetImages: number
  datasetFolders: { dir: string; images: number }[]
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
        SUM(content_state = 3 AND note = 'secret') AS secrets, SUM(content_state = 3 AND note = 'dataset') AS datasetImages,
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
    unreadableFolders: JSON.parse(getMeta(db, "unreadable_folders") ?? "[]"),
    files: counts.files ?? 0,
    folders: counts.folders ?? 0,
    withContent: counts.withContent ?? 0,
    errors: counts.errors ?? 0,
    skipped: counts.skipped ?? 0,
    pending: counts.pending ?? 0,
    secrets: counts.secrets ?? 0,
    datasetImages: counts.datasetImages ?? 0,
    datasetFolders: JSON.parse(getMeta(db, "dataset_folders") ?? "[]"),
    contentBytes: counts.contentBytes ?? 0,
    dbBytes,
    lastIndexedAt: last ? Number(last) : null,
    lastDurationMs: dur ? Number(dur) : null,
    roots: JSON.parse(getMeta(db, "roots") ?? "[]"),
    generation: Number(getMeta(db, "generation") ?? 0),
  }
}
