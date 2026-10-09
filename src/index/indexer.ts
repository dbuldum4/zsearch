import type { Database, Statement } from "bun:sqlite"
import { existsSync } from "node:fs"
import { type Config, home, resolvePath } from "../config.ts"
import { extOf, kindOf, type Kind } from "../kinds.ts"
import { cloudFolders, onlyChildren, systemExcludes, systemNamesOnly } from "../platform.ts"
import { dirTokens, ftsBody, nameTokens } from "../util/text.ts"
import { type CrawlStats, crawl } from "./crawler.ts"
import { ContentState, decompressText, getMeta, loadVocabTerms, setMeta } from "./db.ts"
import { wantsContent } from "./extract/index.ts"
import type { ExtractReply } from "./extract-job.ts"
import { ExtractPool } from "./pool.ts"
import { type ContentItem, type ContentSink, InlineSink, ThreadSink } from "./writer.ts"

export type IndexPhase = "starting" | "scan" | "content" | "cleanup" | "done" | "cancelled" | "error"

export interface IndexProgress {
  phase: IndexPhase
  scanned: number
  added: number
  updated: number
  removed: number
  contentTotal: number
  contentDone: number
  contentBytes: number
  contentErrors: number
  current: string
  startedAt: number
  elapsedMs: number
  error?: string
}

export interface IndexOptions {
  onProgress?: (p: IndexProgress) => void
  signal?: AbortSignal
  /** Run extraction in-process instead of worker threads (tests, tiny indexes). */
  inProcess?: boolean
  /** Called after each committed batch so readers can refresh. */
  onCommit?: () => void
}

/** A file waiting for its contents. */
interface Pending {
  id: number
  path: string
  ext: string
  kind: Kind
  size: number
  /** It has an FTS row already, from an earlier run. */
  inFts: number
}

/** Extraction jobs queued per worker: a deep queue keeps them busy while this thread is not. */
const JOBS_PER_WORKER = 64
/** At most this much (file size, text files) in flight at once. */
const MAX_INFLIGHT_BYTES = 64 * 1024 * 1024
/** Files whose contents are written in rowid order (see `content`). */
const WRITE_RUN = 4096
/** A job still running holds back the writing of at most this many results after it. */
const SKIP_AFTER = 256
/** Results held back behind slow files, at most: beyond this they are written anyway. */
const MAX_HELD_BYTES = 64 * 1024 * 1024

interface Existing {
  id: number
  size: number
  mtime: number
  state: number
  isDir: boolean
  kind: string
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix === "/" ? "/" : prefix + "/")
}

/** Resolve the crawl options from the user's config. */
export function crawlOptionsFor(config: Config) {
  const roots = [...new Set(config.roots.map(resolvePath))]
  const userAbs = config.exclude.filter((p) => p.startsWith("/") || p.startsWith("~")).map(resolvePath)
  const patterns = config.exclude.filter((p) => !(p.startsWith("/") || p.startsWith("~")))
  // Never exclude a folder that contains a root the user asked for.
  const excludes = [...systemExcludes(), ...userAbs].filter((e) => !roots.some((r) => under(r, e)))
  const wholeDisk = roots.includes("/")
  const h = home()
  const namesOnly = [
    ...config.namesOnly.map(resolvePath),
    ...(wholeDisk ? systemNamesOnly() : []),
    // Reading cloud-synced files can download them: names only unless the user opts in.
    ...(config.cloudContent ? [] : cloudFolders()),
  ].filter((p) => !under(h, p))
  return {
    roots,
    includeHidden: config.includeHidden,
    respectGitignore: config.respectGitignore,
    followSymlinks: config.followSymlinks,
    oneFileSystem: config.oneFileSystem,
    excludePatterns: patterns,
    excludePaths: excludes,
    onlyChildren: onlyChildren(),
    namesOnly,
  }
}

export class Indexer {
  private progress: IndexProgress
  private lastEmit = 0
  private manualDelete: boolean
  private h = home()
  private runId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  private st!: {
    insertFile: Statement
    updateFile: Statement
    setState: Statement
    inFts: Statement
    ftsInsert: Statement
    ftsDeleteRow: Statement
    ftsDeleteManual: Statement
    contentGet: Statement
    contentDel: Statement
    fileDel: Statement
  }

  constructor(
    private db: Database,
    private config: Config,
    private opts: IndexOptions = {},
  ) {
    this.manualDelete = getMeta(db, "fts_delete") === "manual"
    const now = Date.now()
    this.progress = {
      phase: "starting",
      scanned: 0,
      added: 0,
      updated: 0,
      removed: 0,
      contentTotal: 0,
      contentDone: 0,
      contentBytes: 0,
      contentErrors: 0,
      current: "",
      startedAt: now,
      elapsedMs: 0,
    }
    const q = (sql: string) => db.prepare(sql)
    this.st = {
      insertFile: q("INSERT INTO files(path, name, ext, kind, is_dir, size, mtime, content_state, in_fts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      updateFile: q(
        "UPDATE files SET ext = ?, kind = ?, is_dir = ?, size = ?, mtime = ?, content_state = ?, seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM files) WHERE id = ?",
      ),
      setState: q("UPDATE files SET content_state = ?, content_len = ?, note = ?, in_fts = 1 WHERE id = ?"),
      inFts: q("SELECT in_fts FROM files WHERE id = ?"),
      ftsInsert: q("INSERT INTO fts(rowid, name, dirs, body) VALUES (?, ?, ?, ?)"),
      ftsDeleteRow: q("DELETE FROM fts WHERE rowid = ?"),
      ftsDeleteManual: q("INSERT INTO fts(fts, rowid, name, dirs, body) VALUES ('delete', ?, ?, ?, ?)"),
      contentGet: q("SELECT data FROM content WHERE id = ?"),
      contentDel: q("DELETE FROM content WHERE id = ?"),
      fileDel: q("DELETE FROM files WHERE id = ?"),
    }
  }

  private emit(force = false) {
    const now = Date.now()
    if (!force && now - this.lastEmit < 100) return
    this.lastEmit = now
    this.progress.elapsedMs = now - this.progress.startedAt
    this.opts.onProgress?.({ ...this.progress })
  }

  private get aborted() {
    return this.opts.signal?.aborted ?? false
  }

  /** Tokens of the folders last seen: files mostly come folder by folder. */
  private dirCache = { dir: "", tokens: "" }

  private ftsFields(path: string) {
    const slash = path.lastIndexOf("/")
    const name = path.slice(slash + 1)
    const dir = slash <= 0 ? "/" : path.slice(0, slash)
    if (dir !== this.dirCache.dir) this.dirCache = { dir, tokens: dirTokens(dir, this.h) }
    return { name: nameTokens(name), dirs: this.dirCache.tokens }
  }

  /** Remove the FTS row of a file, if it has one. `body` must be exactly what was indexed (manual mode). */
  private ftsDelete(id: number, path: string, body: string | null) {
    const row = this.st.inFts.get(id) as { in_fts: number } | null
    if (!row || row.in_fts !== 1) return
    if (!this.manualDelete) {
      this.st.ftsDeleteRow.run(id)
      return
    }
    const f = this.ftsFields(path)
    this.st.ftsDeleteManual.run(id, f.name, f.dirs, body ?? "")
  }

  /** The FTS body a file was indexed with, rebuilt from its stored text (manual mode). */
  private storedBody(id: number): string | null {
    const row = this.st.contentGet.get(id) as { data: Uint8Array } | null
    return row ? ftsBody(decompressText(row.data)) : null
  }

  async run(): Promise<IndexProgress> {
    try {
      setMeta(this.db, "indexing_started_at", String(this.progress.startedAt))
      const removed = this.scan()
      if (this.aborted) return this.finish("cancelled")
      await this.content()
      if (this.aborted) return this.finish("cancelled")
      this.cleanup(removed)
      return this.finish("done")
    } catch (err) {
      this.progress.error = (err as Error).message
      return this.finish("error")
    }
  }

  private finish(phase: IndexPhase): IndexProgress {
    this.progress.phase = phase
    this.progress.current = ""
    if (phase === "done") {
      const now = Date.now()
      setMeta(this.db, "last_indexed_at", String(now))
      setMeta(this.db, "last_duration_ms", String(now - this.progress.startedAt))
      setMeta(this.db, "roots", JSON.stringify(this.config.roots.map(resolvePath)))
      setMeta(this.db, "generation", String(Number(getMeta(this.db, "generation") ?? 0) + 1))
      this.db.exec("PRAGMA optimize")
    }
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)")
    this.opts.onCommit?.()
    this.emit(true)
    return { ...this.progress }
  }

  /* ------------------------------------------------------------- scan -- */

  /** Walk the roots, record new/changed files. Returns ids that disappeared. */
  private scan(): number[] {
    this.progress.phase = "scan"
    this.emit(true)
    const existing = new Map<string, Existing>()
    for (const r of this.db.query("SELECT id, path, size, mtime, content_state AS state, is_dir, kind FROM files").iterate() as IterableIterator<{
      id: number
      path: string
      size: number
      mtime: number
      state: number
      is_dir: number
      kind: string
    }>) {
      existing.set(r.path, { id: r.id, size: r.size, mtime: r.mtime, state: r.state, isDir: r.is_dir === 1, kind: r.kind })
    }
    const visited = new Set<number>()
    const contentOn = this.config.content.enabled
    const stats: CrawlStats = { dirs: 0, files: 0, errors: 0, skipped: 0 }
    const crawlOpts = crawlOptionsFor(this.config)
    let batch: (() => void)[] = []
    let lastCommit = Date.now()
    const commit = () => {
      if (!batch.length) return
      const work = batch
      batch = []
      this.db.transaction(() => {
        for (const fn of work) fn()
      })()
      lastCommit = Date.now()
      this.opts.onCommit?.()
    }
    for (const e of crawl(crawlOpts, stats)) {
      if (this.aborted) break
      this.progress.scanned++
      if ((this.progress.scanned & 255) === 0) {
        this.progress.current = e.path
        this.emit()
      }
      const kind: Kind = kindOf(e.name, e.isDir)
      const ext = e.isDir ? "" : extOf(e.name)
      const wants = !e.isDir && contentOn && !e.namesOnly && !e.offline && wantsContent(ext, kind)
      const prev = existing.get(e.path)
      if (prev) {
        visited.add(prev.id)
        const same = prev.size === e.size && prev.mtime === e.mtime && prev.isDir === e.isDir
        if (same && prev.kind === kind) {
          // Content policy may have changed since the last run.
          if (wants && prev.state === ContentState.None) batch.push(() => this.st.setState.run(ContentState.Pending, 0, null, prev.id))
          else if (!wants && prev.state !== ContentState.None) batch.push(() => this.dropContent(prev.id, e.path, ContentState.None, null))
          continue
        }
        this.progress.updated++
        batch.push(() => {
          if (!wants && prev.state !== ContentState.None) this.dropContent(prev.id, e.path, ContentState.None, null)
          this.st.updateFile.run(ext, kind, e.isDir ? 1 : 0, e.size, e.mtime, wants ? ContentState.Pending : ContentState.None, prev.id)
        })
      } else {
        this.progress.added++
        batch.push(() => {
          // Files waiting for their contents get their FTS row once, in the content phase.
          // run() and lastInsertRowid cost about half as much as RETURNING id.
          const { lastInsertRowid } = this.st.insertFile.run(e.path, e.name, ext, kind, e.isDir ? 1 : 0, e.size, e.mtime, wants ? ContentState.Pending : ContentState.None, wants ? 0 : 1)
          if (!wants) {
            const f = this.ftsFields(e.path)
            this.st.ftsInsert.run(Number(lastInsertRowid), f.name, f.dirs, "")
          }
        })
      }
      if (batch.length >= 2000 || Date.now() - lastCommit > 250) commit()
    }
    commit()
    if (this.aborted) return []
    // Files that vanished. Keep entries under roots that are currently unavailable (unmounted drives).
    const missingRoots = crawlOpts.roots.filter((r) => !existsSync(r))
    const removed: number[] = []
    for (const [path, ex] of existing) {
      if (visited.has(ex.id)) continue
      if (missingRoots.some((r) => under(path, r))) continue
      removed.push(ex.id)
    }
    this.progress.removed = removed.length
    return removed
  }

  /** Remove a file's content and searchable body, keeping the file entry. */
  private dropContent(id: number, path: string, newState: number, note: string | null) {
    const body = this.manualDelete ? this.storedBody(id) : null
    this.ftsDelete(id, path, body)
    const f = this.ftsFields(path)
    this.st.ftsInsert.run(id, f.name, f.dirs, "")
    this.st.contentDel.run(id)
    this.st.setState.run(newState, 0, note, id)
  }

  /* ---------------------------------------------------------- content -- */

  private async content() {
    const pending = this.db
      .query("SELECT id, path, ext, kind, size, in_fts AS inFts FROM files WHERE content_state = ? ORDER BY mtime DESC")
      .all(ContentState.Pending) as Pending[]
    this.progress.phase = "content"
    this.progress.contentTotal = pending.length
    this.emit(true)
    if (pending.length === 0) return
    // Newest files first, in runs of files taken in rowid order: FTS5 writes out what it has
    // gathered whenever a rowid is lower than the last one, and many small segments cost more to
    // write and then to merge.
    for (let i = 0; i < pending.length; i += WRITE_RUN) {
      const run = pending.slice(i, i + WRITE_RUN).sort((a, b) => a.id - b.id)
      for (let k = 0; k < run.length; k++) pending[i + k] = run[k]!
    }
    const c = this.config.content
    const workers = this.config.workers > 0 ? this.config.workers : ExtractPool.defaultSize()
    const maxTextBytes = c.maxTextMB * 1024 * 1024
    const pool = new ExtractPool(
      Math.min(workers, Math.max(1, Math.ceil(pending.length / 4))),
      { maxTextBytes, maxDocBytes: c.maxDocumentMB * 1024 * 1024, maxChars: c.maxChars, pdfTimeoutMs: 60_000 },
      JOBS_PER_WORKER,
      this.opts.inProcess,
    )

    // Resolved by the next finished job, or when the writer catches up. Promise.race over every
    // job in flight would cost a pass over all of them per job, and leave a reaction behind on each.
    let wake: (() => void) | null = null

    // Results are written as they come in, in the order the jobs went out, within a transaction
    // committed about once a second. With a database file, a thread of its own writes them, and
    // this one takes in results and hands out jobs meanwhile.
    const file = this.db.filename
    const onCommit = () => this.opts.onCommit?.()
    const sink: ContentSink = this.opts.inProcess || !file || file === ":memory:" ? new InlineSink(this.db, onCommit) : new ThreadSink(file, onCommit)
    sink.onProgress = () => wake?.()
    this.known ??= loadVocabTerms(this.db)
    const known = this.known
    const done: (ExtractReply | undefined)[] = new Array(pending.length)
    /** Next job to write. */
    let cursor = 0
    /** Results ready from the cursor on. */
    let ahead = 0
    /**
     * Jobs passed over because they took long while results piled up behind them. Their
     * results go in at the end of their run, where the rowids start over anyway.
     */
    const late = new Set<number>()
    const lateDone: number[] = []
    let heldBytes = 0
    let lastCommit = Date.now()
    /** Send what is ready to the writer; with `all`, also what waits behind slow files. */
    const flush = (all: boolean) => {
      const items: ContentItem[] = []
      const fresh: string[] = []
      const take = (i: number) => {
        const r = done[i]!
        done[i] = undefined
        if (r.status === "ok") {
          heldBytes -= r.body.length + r.compressed.length
          for (const t of r.terms) {
            if (known.has(t)) continue
            known.add(t)
            fresh.push(t)
          }
        }
        const f = this.ftsFields(pending[i]!.path)
        // The terms stay here: copying them to the writer would cost it for nothing.
        const reply = r.status === "ok" ? { id: r.id, status: r.status, chars: r.chars, body: r.body, compressed: r.compressed, truncated: r.truncated } : r
        items.push({ reply, name: f.name, dirs: f.dirs, inFts: pending[i]!.inFts })
      }
      const takeLate = () => {
        for (const i of lateDone.splice(0).sort((a, b) => pending[a]!.id - pending[b]!.id)) take(i)
      }
      while (cursor < next) {
        if (done[cursor]) {
          take(cursor)
          ahead--
        } else if (all || ahead >= SKIP_AFTER) late.add(cursor)
        else break
        cursor++
        if (cursor % WRITE_RUN === 0) takeLate()
      }
      if (all) takeLate()
      sink.write(items, fresh)
    }

    // Jobs in flight are bounded by their size as well as their number. Documents count by the
    // text they can yield at most, roughly.
    const cost = (p: Pending) => Math.min(p.size, maxTextBytes)
    let inflightBytes = 0
    let next = 0
    let active = 0
    // The workers are topped up once half their queue is done, so jobs go out in batches.
    const refill = Math.max(1, pool.slots >> 1)
    let ok = false
    try {
      while ((next < pending.length || active) && !sink.failed) {
        // No new jobs while the writer has much to catch up on.
        const behind = sink.backlog > MAX_INFLIGHT_BYTES
        if (!behind && pool.capacity >= Math.min(refill, pending.length - next)) {
          while (next < pending.length && pool.capacity > 0 && !this.aborted) {
            const job = pending[next]!
            if (active && inflightBytes + cost(job) > MAX_INFLIGHT_BYTES) break
            const i = next++
            active++
            inflightBytes += cost(job)
            pool.run({ id: job.id, path: job.path, ext: job.ext, kind: job.kind, size: job.size, run: this.runId }).then((r) => {
              active--
              inflightBytes -= cost(job)
              done[i] = r
              if (late.delete(i)) lateDone.push(i)
              else ahead++
              this.progress.contentDone++
              if (r.status === "ok") {
                this.progress.contentBytes += r.chars
                heldBytes += r.body.length + r.compressed.length
              }
              if (r.status === "error") this.progress.contentErrors++
              this.progress.current = job.path
              this.emit()
              wake?.()
            })
          }
        }
        if (this.aborted) break
        if (active || behind) await new Promise<void>((r) => (wake = r))
        wake = null
        flush(heldBytes > MAX_HELD_BYTES)
        if (Date.now() - lastCommit > 1000) {
          sink.commit()
          lastCommit = Date.now()
        }
      }
      flush(true)
      ok = true
    } finally {
      pool.close()
      if (!ok) sink.abandon()
    }
    await sink.close()
  }

  /** Content terms already in the vocabulary, loaded the first time contents are stored. */
  private known: Set<string> | null = null

  /* ---------------------------------------------------------- cleanup -- */

  private cleanup(removed: number[]) {
    this.progress.phase = "cleanup"
    this.emit(true)
    const sel = this.db.prepare("SELECT path, content_state AS state FROM files WHERE id = ?")
    for (let i = 0; i < removed.length; i += 500) {
      const ids = removed.slice(i, i + 500)
      this.db.transaction(() => {
        for (const id of ids) {
          const row = sel.get(id) as { path: string; state: number } | null
          if (!row) continue
          const body = this.manualDelete ? this.storedBody(id) : null
          this.ftsDelete(id, row.path, body)
          this.st.contentDel.run(id)
          this.st.fileDel.run(id)
        }
      })()
    }
    if (removed.length) this.opts.onCommit?.()
  }
}

