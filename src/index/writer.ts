import type { Database, Statement } from "bun:sqlite"
import { ftsBody } from "../util/text.ts"
import { compressText, ContentState, decompressText, getMeta, openDb } from "./db.ts"
import type { ExtractReply } from "./extract-job.ts"
import { workerUrl } from "../util/workers.ts"

/** What is stored of an extraction: all of it but the vocabulary terms. */
export type StoredReply = Exclude<ExtractReply, { status: "ok" }> | Omit<Extract<ExtractReply, { status: "ok" }>, "terms">

/** An extracted file, ready to store. */
export interface ContentItem {
  reply: StoredReply
  /** The file's FTS `name` and `dirs` tokens. */
  name: string
  dirs: string
  /** The file has an FTS row already, from an earlier run. */
  inFts: number
}

/**
 * FTS5 writes out what it gathers whenever that passes `hashsize` (1 MB by default), and merges
 * the small segments as it goes: with 4 MB, building the index costs about a third less.
 * Larger sizes gain little more, and leave more free pages behind once segments are merged.
 */
const FTS_HASH_SIZE = 4 << 20

/**
 * Stores extracted contents: the file's FTS row, its compressed text and its state, plus the
 * new vocabulary terms. Writes go into a transaction that `commit` ends.
 */
export class ContentWriter {
  private manualDelete: boolean
  private inTx = false
  private tuned = false
  private fresh: string[] = []
  private st: Record<"setState" | "ftsInsert" | "ftsDeleteRow" | "ftsDeleteManual" | "contentGet" | "contentPut" | "contentDel" | "vocabPut", Statement>

  constructor(private db: Database) {
    this.manualDelete = getMeta(db, "fts_delete") === "manual"
    const q = (sql: string) => db.prepare(sql)
    this.st = {
      setState: q("UPDATE files SET content_state = ?, content_len = ?, note = ?, in_fts = 1 WHERE id = ?"),
      ftsInsert: q("INSERT INTO fts(rowid, name, dirs, body) VALUES (?, ?, ?, ?)"),
      ftsDeleteRow: q("DELETE FROM fts WHERE rowid = ?"),
      ftsDeleteManual: q("INSERT INTO fts(fts, rowid, name, dirs, body) VALUES ('delete', ?, ?, ?, ?)"),
      contentGet: q("SELECT data FROM content WHERE id = ?"),
      contentPut: q("INSERT INTO content(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data"),
      contentDel: q("DELETE FROM content WHERE id = ?"),
      vocabPut: q("INSERT INTO vocab_chunks(terms) VALUES (?)"),
    }
  }

  /** Store files, in order, and remember `fresh` vocabulary terms for the commit. */
  write(items: ContentItem[], fresh: string[]): void {
    if (!this.inTx) {
      this.db.exec("BEGIN")
      this.inTx = true
      if (!this.tuned) {
        // A setting of the table, kept in the database: set once, in the first transaction.
        const row = this.db.query("SELECT v FROM fts_config WHERE k = 'hashsize'").get() as { v: number } | null
        if (row?.v !== FTS_HASH_SIZE) this.db.query("INSERT INTO fts(fts, rank) VALUES ('hashsize', ?)").run(FTS_HASH_SIZE)
        this.tuned = true
      }
    }
    for (const t of fresh) this.fresh.push(t)
    for (const item of items) this.store(item)
  }

  private store({ reply: r, name, dirs, inFts }: ContentItem) {
    if (inFts) {
      if (!this.manualDelete) this.st.ftsDeleteRow.run(r.id)
      else {
        // The classic protocol needs exactly what was indexed: rebuilt from the stored text.
        const row = this.st.contentGet.get(r.id) as { data: Uint8Array } | null
        this.st.ftsDeleteManual.run(r.id, name, dirs, row ? ftsBody(decompressText(row.data)) : "")
      }
    }
    if (r.status === "ok") {
      this.st.ftsInsert.run(r.id, name, dirs, r.body)
      this.st.contentPut.run(r.id, r.compressed)
      this.st.setState.run(ContentState.Indexed, r.chars, r.truncated ? "truncated" : null, r.id)
    } else {
      this.st.ftsInsert.run(r.id, name, dirs, "")
      this.st.contentDel.run(r.id)
      if (r.status === "skip") this.st.setState.run(ContentState.Skipped, 0, r.reason, r.id)
      else this.st.setState.run(ContentState.Error, 0, r.error, r.id)
    }
  }

  commit(): void {
    if (!this.inTx) return
    if (this.fresh.length) this.st.vocabPut.run(compressText(this.fresh.join("\n")))
    this.fresh = []
    this.db.exec("COMMIT")
    this.inTx = false
  }

  rollback(): void {
    if (!this.inTx) return
    this.fresh = []
    this.db.exec("ROLLBACK")
    this.inTx = false
  }
}

/** Where the indexer sends extracted contents. */
export interface ContentSink {
  write(items: ContentItem[], fresh: string[]): void
  commit(): void
  /** Bytes sent but not written yet. */
  readonly backlog: number
  /** A write failed: `close` throws its error. */
  readonly failed: boolean
  /** Wait for everything sent to be written and committed. Throws if a write failed. */
  close(): Promise<void>
  /** Drop what is not committed. */
  abandon(): void
  /** Called whenever the writer catches up a little. */
  onProgress?: () => void
}

function itemBytes(items: ContentItem[]): number {
  let n = 0
  for (const { reply: r } of items) n += r.status === "ok" ? r.body.length + r.compressed.length : 64
  return n
}

/** Writes on the calling thread. */
export class InlineSink implements ContentSink {
  private writer: ContentWriter
  readonly backlog = 0
  readonly failed = false

  constructor(
    db: Database,
    private onCommit?: () => void,
  ) {
    this.writer = new ContentWriter(db)
  }

  write(items: ContentItem[], fresh: string[]) {
    this.writer.write(items, fresh)
  }

  commit() {
    this.writer.commit()
    this.onCommit?.()
  }

  async close() {
    this.commit()
  }

  abandon() {
    this.writer.rollback()
  }
}

export type WriteWorkerIn =
  | { type: "open"; path: string; role: "writer" | "checkpointer" }
  | { type: "write"; items: ContentItem[]; fresh: string[]; bytes: number }
  | { type: "commit" }
  | { type: "checkpoint"; last?: boolean }
export type WriteWorkerOut = { type: "written"; bytes: number } | { type: "committed" } | { type: "checkpointed" } | { type: "error"; error: string }

/**
 * The writer leaves copying the log into the database (and the syncs that go with it) to a
 * thread of its own, which does it after each commit. SQLite still does it on the writer's
 * connection once the log passes this many pages, so the log cannot grow without bound.
 */
export const WRITER_AUTOCHECKPOINT = 8192

/**
 * Writes on a thread of its own, with its own connection, so that the indexer thread can take
 * in the workers' results while SQLite builds the full-text index. Nothing else may write to
 * the database until `close` resolves.
 */
export class ThreadSink implements ContentSink {
  private worker: Worker
  private checkpointer: Worker
  private sent = 0
  private written = 0
  private commits = 0
  private error: string | null = null
  private waiters: (() => void)[] = []

  onProgress?: () => void

  constructor(
    path: string,
    private onCommit?: () => void,
  ) {
    this.worker = new Worker(workerUrl("index/write-worker.ts"))
    this.worker.onmessage = (ev: MessageEvent<WriteWorkerOut>) => {
      const m = ev.data
      if (m.type === "written") this.written += m.bytes
      else if (m.type === "committed") {
        this.commits--
        this.checkpointer.postMessage({ type: "checkpoint" } satisfies WriteWorkerIn)
        this.onCommit?.()
      } else if (m.type === "error") this.error ??= m.error
      this.onProgress?.()
      for (const w of this.waiters.splice(0)) w()
    }
    this.worker.onerror = (ev) => {
      ev.preventDefault?.()
      this.error ??= (ev as ErrorEvent).message || "database writer crashed"
      this.commits = 0
      this.onProgress?.()
      for (const w of this.waiters.splice(0)) w()
    }
    this.post({ type: "open", path, role: "writer" })
    // Its failures do not matter: the writer's connection and the indexer's last checkpoint
    // do the copying anyway.
    this.checkpointer = new Worker(workerUrl("index/write-worker.ts"))
    this.checkpointer.onerror = (ev) => ev.preventDefault?.()
    this.checkpointer.onmessage = () => this.checkpointer.terminate()
    this.checkpointer.postMessage({ type: "open", path, role: "checkpointer" } satisfies WriteWorkerIn)
  }

  private post(msg: WriteWorkerIn, transfer: ArrayBuffer[] = []) {
    this.worker.postMessage(msg, transfer)
  }

  get backlog() {
    return this.sent - this.written
  }

  get failed() {
    return this.error !== null
  }

  write(items: ContentItem[], fresh: string[]) {
    if (!items.length && !fresh.length) return
    const bytes = itemBytes(items)
    this.sent += bytes
    const transfer: ArrayBuffer[] = []
    for (const { reply: r } of items) if (r.status === "ok") transfer.push(r.body.buffer as ArrayBuffer, r.compressed.buffer as ArrayBuffer)
    this.post({ type: "write", items, fresh, bytes }, transfer)
  }

  commit() {
    this.commits++
    this.post({ type: "commit" })
  }

  async close() {
    this.commit()
    while (this.commits > 0 && !this.error) await new Promise<void>((r) => this.waiters.push(r))
    this.worker.terminate()
    if (this.error) {
      this.checkpointer.terminate()
      throw new Error(this.error)
    }
    // The last copy into the database goes on without holding up the end of the run (the
    // indexer's own checkpoint skips what this one is doing). It is safe to cut short.
    this.checkpointer.postMessage({ type: "checkpoint", last: true } satisfies WriteWorkerIn)
    this.checkpointer.unref()
  }

  abandon() {
    // Terminating the thread closes its connection, which rolls back what it has not committed.
    this.worker.terminate()
    this.checkpointer.terminate()
  }
}

/** Opens the writer's own connection to the database at `path`. */
export function openWriter(path: string): ContentWriter {
  const db = openDb(path)
  db.exec(`PRAGMA wal_autocheckpoint = ${WRITER_AUTOCHECKPOINT}`)
  return new ContentWriter(db)
}
