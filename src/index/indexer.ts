import type { Database, Statement } from "bun:sqlite"
import { existsSync } from "node:fs"
import { type Config, home, resolvePath } from "../config.ts"
import { extOf, kindOf, SEMANTIC_KINDS, type Kind } from "../kinds.ts"
import { cloudFolders, onlyChildren, systemExcludes, systemNamesOnly } from "../platform.ts"
import { chunkText } from "../semantic/chunk.ts"
import { createEmbedder, type DownloadProgress, type Embedder, embedderId } from "../semantic/embedder.ts"
import { encodeVector } from "../semantic/vectors.ts"
import { dirTokens, nameTokens } from "../util/text.ts"
import { type CrawlStats, crawl } from "./crawler.ts"
import { ContentState, decompressText, getMeta, setMeta } from "./db.ts"
import { wantsContent } from "./extract/index.ts"
import type { ExtractReply } from "./extract-job.ts"
import { ExtractPool } from "./pool.ts"

export type IndexPhase = "starting" | "scan" | "content" | "semantic" | "cleanup" | "done" | "cancelled" | "error"

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
  semanticTotal: number
  semanticDone: number
  chunks: number
  current: string
  startedAt: number
  elapsedMs: number
  message?: string
  error?: string
}

export interface IndexOptions {
  onProgress?: (p: IndexProgress) => void
  signal?: AbortSignal
  /** Run extraction in-process instead of worker threads (tests, tiny indexes). */
  inProcess?: boolean
  /** Skip the semantic phase even if enabled. */
  skipSemantic?: boolean
  onModelDownload?: DownloadProgress
  /** Inject an embedder (tests). */
  embedder?: Embedder
  /** Called after each committed batch so readers can refresh. */
  onCommit?: () => void
}

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
    contentPut: Statement
    contentDel: Statement
    chunksDel: Statement
    fileDel: Statement
    vocabPut: Statement
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
      semanticTotal: 0,
      semanticDone: 0,
      chunks: 0,
      current: "",
      startedAt: now,
      elapsedMs: 0,
    }
    const q = (sql: string) => db.prepare(sql)
    this.st = {
      insertFile: q("INSERT INTO files(path, name, ext, kind, is_dir, size, mtime, content_state, in_fts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"),
      updateFile: q("UPDATE files SET ext = ?, kind = ?, is_dir = ?, size = ?, mtime = ?, content_state = ? WHERE id = ?"),
      setState: q("UPDATE files SET content_state = ?, content_len = ?, embed_mtime = 0, note = ?, in_fts = 1 WHERE id = ?"),
      inFts: q("SELECT in_fts FROM files WHERE id = ?"),
      ftsInsert: q("INSERT INTO fts(rowid, name, dirs, body) VALUES (?, ?, ?, ?)"),
      ftsDeleteRow: q("DELETE FROM fts WHERE rowid = ?"),
      ftsDeleteManual: q("INSERT INTO fts(fts, rowid, name, dirs, body) VALUES ('delete', ?, ?, ?, ?)"),
      contentGet: q("SELECT data FROM content WHERE id = ?"),
      contentPut: q("INSERT INTO content(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data"),
      contentDel: q("DELETE FROM content WHERE id = ?"),
      chunksDel: q("DELETE FROM chunks WHERE file_id = ?"),
      fileDel: q("DELETE FROM files WHERE id = ?"),
      vocabPut: q("INSERT OR IGNORE INTO vocab(term) VALUES (?)"),
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

  private ftsFields(path: string) {
    const slash = path.lastIndexOf("/")
    const name = path.slice(slash + 1)
    return { name: nameTokens(name), dirs: dirTokens(slash <= 0 ? "/" : path.slice(0, slash), this.h) }
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

  private storedBody(id: number): string | null {
    const row = this.st.contentGet.get(id) as { data: Uint8Array } | null
    return row ? decompressText(row.data) : null
  }

  async run(): Promise<IndexProgress> {
    try {
      setMeta(this.db, "indexing_started_at", String(this.progress.startedAt))
      const removed = this.scan()
      if (this.aborted) return this.finish("cancelled")
      await this.content()
      if (this.aborted) return this.finish("cancelled")
      if (this.config.semantic.enabled && !this.opts.skipSemantic) {
        await this.semantic()
        if (this.aborted) return this.finish("cancelled")
      }
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
          else if (!wants && prev.state !== ContentState.None) batch.push(() => this.dropContent(prev.id, e.path, prev.state, ContentState.None, null))
          continue
        }
        this.progress.updated++
        batch.push(() => {
          if (!wants && prev.state !== ContentState.None) this.dropContent(prev.id, e.path, prev.state, ContentState.None, null)
          this.st.updateFile.run(ext, kind, e.isDir ? 1 : 0, e.size, e.mtime, wants ? ContentState.Pending : ContentState.None, prev.id)
        })
      } else {
        this.progress.added++
        batch.push(() => {
          // Files waiting for their contents get their FTS row once, in the content phase.
          const row = this.st.insertFile.get(e.path, e.name, ext, kind, e.isDir ? 1 : 0, e.size, e.mtime, wants ? ContentState.Pending : ContentState.None, wants ? 0 : 1) as { id: number }
          if (!wants) {
            const f = this.ftsFields(e.path)
            this.st.ftsInsert.run(row.id, f.name, f.dirs, "")
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
  private dropContent(id: number, path: string, _prevState: number, newState: number, note: string | null) {
    const body = this.manualDelete ? this.storedBody(id) : null
    this.ftsDelete(id, path, body)
    const f = this.ftsFields(path)
    this.st.ftsInsert.run(id, f.name, f.dirs, "")
    this.st.contentDel.run(id)
    this.st.chunksDel.run(id)
    this.st.setState.run(newState, 0, note, id)
  }

  /* ---------------------------------------------------------- content -- */

  private async content() {
    const pending = this.db
      .query("SELECT id, path, ext, kind, size FROM files WHERE content_state = ? ORDER BY mtime DESC")
      .all(ContentState.Pending) as { id: number; path: string; ext: string; kind: Kind; size: number }[]
    this.progress.phase = "content"
    this.progress.contentTotal = pending.length
    this.emit(true)
    if (pending.length === 0) return
    const c = this.config.content
    const workers = this.config.workers > 0 ? this.config.workers : ExtractPool.defaultSize()
    const pool = new ExtractPool(
      Math.min(workers, Math.max(1, Math.ceil(pending.length / 4))),
      { maxTextBytes: c.maxTextMB * 1024 * 1024, maxDocBytes: c.maxDocumentMB * 1024 * 1024, maxChars: c.maxChars, pdfTimeoutMs: 60_000 },
      2,
      this.opts.inProcess,
    )
    const paths = new Map(pending.map((p) => [p.id, p.path]))
    let results: ExtractReply[] = []
    let lastCommit = Date.now()
    const commit = () => {
      if (!results.length) return
      const work = results
      results = []
      this.db.transaction(() => {
        for (const r of work) this.storeResult(r, paths.get(r.id)!)
      })()
      lastCommit = Date.now()
      this.opts.onCommit?.()
    }
    try {
      let next = 0
      const inflight = new Set<Promise<void>>()
      while (next < pending.length || inflight.size) {
        while (next < pending.length && pool.capacity > 0 && !this.aborted) {
          const job = pending[next++]!
          const p: Promise<void> = pool.run({ ...job, run: this.runId }).then((r) => {
            inflight.delete(p)
            results.push(r)
            this.progress.contentDone++
            if (r.status === "ok") this.progress.contentBytes += r.text.length
            if (r.status === "error") this.progress.contentErrors++
            this.progress.current = job.path
            this.emit()
          })
          inflight.add(p)
        }
        if (this.aborted) break
        if (inflight.size) await Promise.race(inflight)
        if (results.length >= 512 || Date.now() - lastCommit > 1000) commit()
      }
      commit()
    } finally {
      pool.close()
    }
  }

  private storeResult(r: ExtractReply, path: string) {
    const hadBody = this.manualDelete ? this.storedBody(r.id) : null
    this.ftsDelete(r.id, path, hadBody)
    const f = this.ftsFields(path)
    this.st.chunksDel.run(r.id)
    if (r.status === "ok") {
      this.st.ftsInsert.run(r.id, f.name, f.dirs, r.text)
      this.st.contentPut.run(r.id, r.compressed)
      this.st.setState.run(ContentState.Indexed, r.text.length, r.truncated ? "truncated" : null, r.id)
      for (const t of r.terms) this.st.vocabPut.run(t)
    } else {
      this.st.ftsInsert.run(r.id, f.name, f.dirs, "")
      this.st.contentDel.run(r.id)
      if (r.status === "skip") this.st.setState.run(ContentState.Skipped, 0, r.reason, r.id)
      else this.st.setState.run(ContentState.Error, 0, r.error, r.id)
    }
  }

  /* --------------------------------------------------------- semantic -- */

  private async semantic() {
    const cfg = this.config.semantic
    const id = embedderId(cfg)
    if (getMeta(this.db, "semantic_model") !== id) {
      this.db.transaction(() => {
        this.db.exec("DELETE FROM chunks")
        this.db.exec("UPDATE files SET embed_mtime = 0")
        setMeta(this.db, "semantic_model", id)
      })()
    }
    const kinds = [...SEMANTIC_KINDS].map((k) => `'${k}'`).join(",")
    const todo = this.db
      .query(`SELECT id, path, name, mtime FROM files WHERE content_state = 1 AND embed_mtime <> mtime AND kind IN (${kinds}) ORDER BY mtime DESC`)
      .all() as { id: number; path: string; name: string; mtime: number }[]
    this.progress.phase = "semantic"
    this.progress.semanticTotal = todo.length
    this.progress.message = undefined
    this.emit(true)
    if (todo.length === 0) return
    let embedder = this.opts.embedder
    if (!embedder) {
      this.progress.message = "loading semantic model"
      this.emit(true)
      embedder = await createEmbedder(cfg, {
        signal: this.opts.signal,
        onDownload: (file, received, total) => {
          this.progress.message = `downloading model ${file} ${total ? Math.round((received / total) * 100) + "%" : `${Math.round(received / 1e6)} MB`}`
          this.opts.onModelDownload?.(file, received, total)
          this.emit()
        },
      })
      this.progress.message = undefined
    }
    const insert = this.db.prepare("INSERT INTO chunks(file_id, start, end, vec) VALUES (?, ?, ?, ?)")
    const mark = this.db.prepare("UPDATE files SET embed_mtime = ? WHERE id = ?")
    const getContent = this.db.prepare("SELECT data FROM content WHERE id = ?")
    for (let i = 0; i < todo.length; i += 16) {
      if (this.aborted) return
      const group = todo.slice(i, i + 16)
      const items: { fileId: number; start: number; end: number; text: string }[] = []
      for (const f of group) {
        const row = getContent.get(f.id) as { data: Uint8Array } | null
        if (!row) continue
        const text = decompressText(row.data)
        const title = f.name.replace(/\.[^.]+$/, "").replace(/[_\-.]+/g, " ")
        for (const c of chunkText(text, { maxChunks: cfg.maxChunksPerFile })) {
          items.push({ fileId: f.id, start: c.start, end: c.end, text: `${title}\n${text.slice(c.start, c.end)}` })
        }
      }
      const vectors: Float32Array[] = []
      for (let j = 0; j < items.length; j += 64) vectors.push(...(await embedder.embedDocuments(items.slice(j, j + 64).map((x) => x.text))))
      this.db.transaction(() => {
        for (const f of group) this.st.chunksDel.run(f.id)
        items.forEach((it, k) => insert.run(it.fileId, it.start, it.end, encodeVector(vectors[k]!)))
        for (const f of group) mark.run(f.mtime || 1, f.id)
      })()
      this.progress.semanticDone += group.length
      this.progress.chunks += items.length
      this.progress.current = group[group.length - 1]!.path
      this.opts.onCommit?.()
      this.emit()
    }
  }

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
          this.st.chunksDel.run(id)
          this.st.fileDel.run(id)
        }
      })()
    }
    if (removed.length) this.opts.onCommit?.()
  }
}

