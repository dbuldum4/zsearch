import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

/** Bump when the on-disk layout or tokenisation changes; older indexes are rebuilt. */
const SCHEMA_VERSION = 11

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

/**
 * What OCR read in images and scanned PDF pages, by file identity: OCR takes a fraction of a
 * second per image or page, and a rebuilt index reads it from here instead. Kept across schema
 * changes; rows whose file is no longer indexed go at the end of each run (see `pruneOcrCache`).
 */
const OCR_CACHE_TABLE = `CREATE TABLE IF NOT EXISTS ocr_cache (
  id INTEGER PRIMARY KEY, dev INTEGER NOT NULL, ino INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
  version INTEGER NOT NULL, data BLOB NOT NULL
)`
const OCR_CACHE_KEY = "CREATE UNIQUE INDEX IF NOT EXISTS ocr_cache_key ON ocr_cache(dev, ino, size, mtime)"

/**
 * Stored texts are kept once however many files hold them (copies are common in Downloads):
 * `texts` holds them, `content_map` says which file has which, with the text's hash. `content`
 * is a view of both with the layout of the table it replaced, (file id, compressed text), so
 * readers and deletes need not know. A text no file holds any more is deleted with its last row.
 */
function createContentTables(db: Database) {
  db.exec("CREATE TABLE texts (id INTEGER PRIMARY KEY, data BLOB NOT NULL)")
  db.exec("CREATE TABLE content_map (id INTEGER PRIMARY KEY, text INTEGER NOT NULL, hash BLOB)")
  db.exec("CREATE INDEX content_map_text ON content_map(text)")
  db.exec("CREATE INDEX content_map_hash ON content_map(hash)")
  const unused = "DELETE FROM texts WHERE id = OLD.text AND NOT EXISTS (SELECT 1 FROM content_map WHERE text = OLD.text);"
  db.exec(`CREATE TRIGGER content_map_delete AFTER DELETE ON content_map BEGIN ${unused} END`)
  db.exec(`CREATE TRIGGER content_map_update AFTER UPDATE OF text ON content_map WHEN OLD.text <> NEW.text BEGIN ${unused} END`)
  db.exec("CREATE VIEW content(id, data) AS SELECT m.id, t.data FROM content_map m JOIN texts t ON t.id = m.text")
  db.exec("CREATE TRIGGER content_delete INSTEAD OF DELETE ON content BEGIN DELETE FROM content_map WHERE id = OLD.id; END")
  // Texts written without a hash are not shared.
  db.exec(`CREATE TRIGGER content_insert INSTEAD OF INSERT ON content BEGIN
    DELETE FROM content_map WHERE id = NEW.id;
    INSERT INTO texts(data) VALUES (NEW.data);
    INSERT INTO content_map(id, text) VALUES (NEW.id, last_insert_rowid());
  END`)
}

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
  // The log is copied into the database and started over at checkpoints, but keeps its largest
  // size on disk unless told otherwise: after a big run, that can be as much as the index.
  db.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT}`)
  if (path !== ":memory:") for (const suffix of ["-wal", "-shm"]) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600)
  if (!opts.readonly) migrate(db, opts)
  return db
}

const JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024

function migrate(db: Database, opts: OpenOptions) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const version = Number(getMeta(db, "schema_version") ?? 0)
  if (version === SCHEMA_VERSION) {
    // Added after version 8 without a rebuild: older indexes get it here.
    db.exec(REMOVED_TABLE)
    db.exec(OCR_CACHE_TABLE)
    db.exec(OCR_CACHE_KEY)
    return
  }
  db.transaction(() => {
    const views = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'view'").all() as { name: string }[]).map((r) => r.name))
    // "chunks" held semantic search vectors before version 6; "vocab" was one row per term before version 7.
    for (const t of ["fts", "fts_v", "files", "content", "content_map", "texts", "chunks", "vocab", "vocab_chunks", "removed"]) db.exec(`DROP ${views.has(t) ? "VIEW" : "TABLE"} IF EXISTS ${t}`)
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
    createContentTables(db)
    db.exec(OCR_CACHE_TABLE)
    db.exec(OCR_CACHE_KEY)
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

/**
 * Empty the index (files, texts, vocabulary) in place, so that the next run rebuilds it. What OCR
 * read stays for that run, which drops what it no longer indexes (see `pruneOcrCache`).
 */
export function clearIndex(db: Database): void {
  db.transaction(() => {
    if (getMeta(db, "fts_delete") === "manual") {
      db.exec("DROP TABLE fts")
      db.exec("CREATE VIRTUAL TABLE fts USING fts5(name, dirs, body, content='', tokenize='unicode61 remove_diacritics 2', detail=column)")
    } else {
      db.exec("INSERT INTO fts(fts) VALUES ('delete-all')")
    }
    db.exec("DELETE FROM texts")
    db.exec("DELETE FROM content_map")
    db.exec("DELETE FROM files")
    db.exec("DELETE FROM vocab_chunks")
    db.exec("DELETE FROM removed")
    setMeta(db, "generation", String(Number(getMeta(db, "generation") ?? 0) + 1))
    // Empty until a run completes: it must not look up to date meanwhile.
    db.exec("DELETE FROM meta WHERE key IN ('last_indexed_at', 'last_duration_ms')")
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
    vacuum(db)
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } catch {
    // Busy: the free pages are reused by the next writes instead.
  }
}

/** VACUUM copies the database into a temporary one: on disk, or a big index would take as much memory. */
function vacuum(db: Database) {
  db.exec("PRAGMA temp_store = FILE")
  try {
    db.exec("VACUUM")
  } finally {
    db.exec("PRAGMA temp_store = MEMORY")
  }
}

/** Free pages worth giving back, at least: below this, the next writes reuse them anyway. */
const VACUUM_FREE_SHARE = 0.1
const VACUUM_FREE_BYTES = 4 * 1024 * 1024

/**
 * Tidy the index after a run that wrote much of it. With `optimizeFts`, the full-text index is
 * merged into one segment: FTS5 merges as it goes, but leaves many segments behind, which
 * queries read one by one, and the pages of the merged ones free. Free pages are then given back
 * to the file system when they are a good share of the file, which VACUUM does by rewriting it.
 * Returns whether it did.
 */
export function compactIndex(db: Database, optimizeFts: boolean): boolean {
  try {
    if (optimizeFts) db.exec("INSERT INTO fts(fts) VALUES ('optimize')")
    const pages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count
    const free = (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count
    const size = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size
    if (free < pages * VACUUM_FREE_SHARE || free * size < VACUUM_FREE_BYTES) return false
    vacuum(db)
    // Readers still open keep the log at its size until their next transaction; the size limit
    // trims it at a later checkpoint then.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    return true
  } catch {
    // Busy, or out of disk space for the copy: the free pages are reused by the next writes.
    return false
  }
}

/**
 * Drop OCR results whose file is no longer indexed with its text: deleted, changed, excluded,
 * or with contents turned off since. With OCR off (`ocr` false), all of them go: a PDF with
 * text of its own stays indexed without what OCR read on its scanned pages.
 */
export function pruneOcrCache(db: Database, ocr: boolean): void {
  if (!db.query("SELECT 1 FROM ocr_cache LIMIT 1").get()) return
  if (!ocr) {
    db.exec("DELETE FROM ocr_cache")
    return
  }
  db.query(
    "DELETE FROM ocr_cache WHERE (dev, ino, size, mtime) NOT IN (SELECT dev, ino, size, mtime FROM files WHERE content_state = ?)",
  ).run(ContentState.Indexed)
}

/** Version of what `ocr_cache` holds: bump when the OCR helper reads differently. */
export const OCR_CACHE_VERSION = 1

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
 * Higher levels cost only compression time: both codecs decompress as fast. On text files,
 * deflate at 6 stores mid-sized texts in about 30% of their size (42% at 1), and zstd at 9 large
 * ones in about 18% (20% at 3), still compressing at over 50 MB/s.
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

/** Identifies a stored text, to keep it once: SHA-256 of its UTF-8 bytes, cut to 128 bits. */
export function textHash(raw: Uint8Array): Uint8Array {
  return Uint8Array.from(new Bun.CryptoHasher("sha256").update(raw).digest().subarray(0, 16))
}

export function encodeText(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text)
}

/** `compressText` of the text these UTF-8 bytes hold. */
export function compressBytes(raw: Uint8Array<ArrayBuffer>): Uint8Array {
  if (raw.length >= RAW_BELOW) {
    const z = raw.length >= ZSTD_FROM ? Bun.zstdCompressSync(raw, { level: 9 }) : Bun.deflateSync(raw, { level: 6 })
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
