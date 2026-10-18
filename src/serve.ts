/**
 * `zsearch serve`: the search engine without a terminal UI, for the macOS app.
 *
 * Requests arrive on stdin and replies and events leave on stdout, one JSON object per line.
 * A request may carry a numeric `id`; its reply carries the same `id`. Search and preview
 * requests supersede older ones of the same type, which then reply `cancelled`.
 * The server exits when stdin closes.
 */
import { createInterface } from "node:readline"
import { type Config, configExists, configStamp, ensureDirs, loadConfig, manualIndexing, validateConfigPatch, saveConfig } from "./config.ts"
import { type IndexStats, partialRunHolds } from "./index/db.ts"
import { IndexRun } from "./index/client.ts"
import { combine, describeEstimate, ESTIMATE_CANCELLED, estimateInBackground, type FolderEstimate } from "./index/estimate.ts"
import type { IndexProgress } from "./index/indexer.ts"
import { lockHolder } from "./index/lock.ts"
import { RootWatcher } from "./index/watch.ts"
import { SearchClient } from "./search/client.ts"
import type { Preview, SearchResponse } from "./search/engine.ts"
import { MODES, type Mode } from "./search/query.ts"
import { removeSemantic, type SemanticStatus, semanticStatus } from "./semantic/manage.ts"
import { downloadModels } from "./semantic/model.ts"

type ServeIn =
  | { id?: number; type: "search"; query: string; mode?: Mode; limit?: number }
  | { id?: number; type: "preview"; file: number; query: string; mode?: Mode; focusLine?: number }
  | { id?: number; type: "previews"; files: number[]; query: string; mode?: Mode; focusLines?: (number | null)[] }
  | { id?: number; type: "stats" }
  | { id?: number; type: "config" }
  | { id?: number; type: "setConfig"; config: Partial<Config> }
  | { id?: number; type: "index"; rebuild?: boolean; background?: boolean; meaningOnly?: boolean }
  | { id?: number; type: "meaningIndex" }
  | { id?: number; type: "cancelIndex" }
  | { id?: number; type: "opened"; path: string }
  | { id?: number; type: "estimate"; roots: string[] }
  | { id?: number; type: "semanticStatus" }
  | { id?: number; type: "semanticInstall" }
  | { id?: number; type: "semanticCancelInstall" }
  | { id?: number; type: "semanticRemove" }

type ServeOut =
  | { type: "ready"; version: string; files: number; firstRun: boolean; config: Config }
  | { id?: number; type: "results"; response: SearchResponse }
  | { id?: number; type: "preview"; preview: Preview }
  | { id?: number; type: "previews"; previews: Preview[] }
  | { id?: number; type: "stats"; stats: IndexStats }
  | { id?: number; type: "config"; config: Config }
  | { id?: number; type: "cancelled" }
  | { id?: number; type: "ok" }
  | { id?: number; type: "estimate"; estimates: FolderEstimate[]; total: FolderEstimate; text: string }
  | { id?: number; type: "error"; error: string }
  | { type: "indexProgress"; progress: IndexProgress }
  | { type: "indexDone"; status: "done" | "cancelled" | "error" | "locked"; progress?: IndexProgress; error?: string }
  | { type: "refreshed"; files: number; changed: boolean }
  | { id?: number; type: "semantic"; status: SemanticStatus }
  | { type: "semanticDownload"; file: string; received: number; total: number }

/** Progress events are throttled to this interval; the last one before `indexDone` always goes out. */
const PROGRESS_MS = 100

export async function serve(version: string): Promise<number> {
  const p = ensureDirs()
  const firstRun = !configExists()
  let config = loadConfig()
  // Requests come per keystroke: the config file is read again only when it changed.
  let seen = configStamp()
  const client = new SearchClient(p.db, config)
  client.keepSemanticReady()
  let index: IndexRun | null = null
  /** The estimate being counted: a newer request supersedes it. */
  const estimating: { run: { cancel: () => void } | null } = { run: null }
  let closed = false
  /** The model download, while one runs. */
  const downloading: { run: AbortController | null } = { run: null }
  /**
   * A run to start when the one going ends: one asked for while a refresh of changed paths runs
   * (which does not walk every root), or one semantic search's install asks for.
   */
  let followUp: { rebuild: boolean; background: boolean; meaningOnly: boolean } | null = null
  const queue = (next: { rebuild: boolean; background: boolean; meaningOnly: boolean }) => {
    followUp = followUp
      ? { rebuild: followUp.rebuild || next.rebuild, background: followUp.background && next.background, meaningOnly: followUp.meaningOnly && next.meaningOnly }
      : next
  }
  /** The run going updates changed paths only (as far as known yet). */
  let partial = false
  const watcher = new RootWatcher((changed) => {
    if (firstRun && !configExists()) return
    if (index || lockHolder(p.lock) !== null) return false
    startIndex(undefined, false, true, false, changed)
  })
  watcher.update(config)

  const send = (m: ServeOut): void => void process.stdout.write(JSON.stringify(m) + "\n")
  const mode = (m: unknown): Mode => (MODES.includes(m as Mode) ? (m as Mode) : config.defaultMode)

  client.onRefreshed = (files, changed) => send({ type: "refreshed", files, changed })
  client.onRestart = (reason) => send({ type: "error", error: reason })

  /**
   * `background`: the run started on its own (file changes, the app's schedule), not on request.
   * `paths`: the files that changed, or null for file events that need every root walked.
   */
  const startIndex = (id?: number, rebuild = false, background = false, meaningOnly = false, paths?: string[] | null) => {
    if (closed) return
    config = loadConfig()
    client.setConfig(config)
    watcher.update(config)
    if (index) {
      // Asked for while one runs, perhaps waiting on power: that one goes on now.
      if (!background) {
        index.goNow()
        if (partial) queue({ rebuild, background: false, meaningOnly })
        return send({ id, type: "ok" })
      }
      return send({ id, type: "error", error: "indexing is already running" })
    }
    const other = lockHolder(p.lock)
    // A run asked for waits for another process's refresh of changed paths (see the index worker).
    if (other !== null && (background || paths !== undefined || !partialRunHolds(p.db))) return send({ id, type: "error", error: `another zsearch process (pid ${other}) is updating the index` })
    let last = 0
    let pending: IndexProgress | null = null
    // A held-back event goes out once the interval is up: the last one before a quiet spell
    // (a run waiting on power, say) would otherwise wait for the next.
    let trailing: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      trailing = null
      if (!pending || index !== run) return
      last = Date.now()
      send({ type: "indexProgress", progress: pending })
      pending = null
    }
    const run = new IndexRun(config, p.db, p.lock, {
      onProgress: (progress) => {
        if (progress.phase !== "starting") partial = progress.partial === true
        pending = progress
        const now = Date.now()
        if (now - last < PROGRESS_MS) { trailing ??= setTimeout(flush, PROGRESS_MS - (now - last)); return }
        flush()
      },
      onCommit: () => client.refresh(),
    }, rebuild, background, meaningOnly, paths ?? undefined)
    index = run
    // Until its walk starts, a run with paths is taken to update just those.
    partial = Array.isArray(paths)
    send({ id, type: "ok" })
    void run.done.then((outcome) => {
      if (trailing) clearTimeout(trailing)
      index = null
      if (pending) send({ type: "indexProgress", progress: pending })
      client.refresh(true)
      if (paths !== undefined && outcome.status !== "done") watcher.carryOver(paths)
      if (outcome.status === "fatal") send({ type: "indexDone", status: "error", error: outcome.error })
      else if (outcome.status === "locked") send({ type: "indexDone", status: "locked" })
      else send({ type: "indexDone", status: outcome.status, progress: outcome.progress, error: outcome.progress.error })
      const next = followUp
      followUp = null
      // A run that turned out to walk every root already did what a plain update asked for.
      const covered = outcome.status === "done" && !outcome.progress.partial && !next?.rebuild && !next?.meaningOnly && !next?.background
      if (next && outcome.status !== "cancelled" && !covered) startIndex(undefined, next.rebuild, next.background, next.meaningOnly)
    })
  }

  const handle = async (msg: ServeIn) => {
    const id = typeof msg.id === "number" ? msg.id : undefined
    const stamp = configStamp()
    if (stamp !== seen) {
      seen = stamp
      const latest = loadConfig()
      if (JSON.stringify(latest) !== JSON.stringify(config)) {
        config = latest; client.setConfig(config); watcher.update(config)
      }
    }
    switch (msg.type) {
      case "search": {
        const response = await client.search(String(msg.query ?? ""), mode(msg.mode), msg.limit ?? 200)
        return send(response ? { id, type: "results", response } : { id, type: "cancelled" })
      }
      case "preview": {
        const preview = await client.preview(msg.file, String(msg.query ?? ""), mode(msg.mode), msg.focusLine)
        return send(preview ? { id, type: "preview", preview } : { id, type: "cancelled" })
      }
      case "previews": {
        const pairs = Array.isArray(msg.files) ? msg.files.map((f, i) => [f, Array.isArray(msg.focusLines) ? msg.focusLines[i] : null] as const) : []
        const valid = pairs.filter(([f]) => typeof f === "number").slice(0, 32)
        const lines = valid.map(([, l]) => (typeof l === "number" ? l : null))
        const previews = await client.previews(
          valid.map(([f]) => f),
          String(msg.query ?? ""),
          mode(msg.mode),
          lines,
        )
        return send(previews ? { id, type: "previews", previews } : { id, type: "cancelled" })
      }
      case "stats": {
        const reply = await client.stats()
        return send(reply ? { id, type: "stats", stats: reply.stats } : { id, type: "cancelled" })
      }
      case "config":
        config = loadConfig()
        client.setConfig(config)
        watcher.update(config)
        return send({ id, type: "config", config })
      case "setConfig": {
        // A patch: settings it leaves out keep their current values.
        const wasTranscribing = config.content.enabled && config.content.transcribe
        config = validateConfigPatch(loadConfig(), msg.config)
        saveConfig(config)
        client.setConfig(config)
        watcher.update(config)
        // Opting out stops an in-flight helper as well as hiding already stored transcripts.
        if (wasTranscribing && (!config.content.enabled || !config.content.transcribe)) index?.cancel()
        return send({ id, type: "config", config })
      }
      case "index":
        return startIndex(id, msg.rebuild === true, msg.background === true, msg.meaningOnly === true)
      case "meaningIndex":
        return startIndex(id, false, false, true)
      case "cancelIndex":
        followUp = null
        index?.cancel()
        return send({ id, type: "ok" })
      case "estimate": {
        // Counting a big folder takes seconds: on a worker, and only the latest request's.
        estimating.run?.cancel()
        const roots = Array.isArray(msg.roots) ? msg.roots.filter((r): r is string => typeof r === "string").slice(0, 32) : []
        if (!roots.length) return send({ id, type: "error", error: "estimate needs folders" })
        const run = estimateInBackground(roots, config)
        estimating.run = run
        try {
          const estimates = await run.done
          const total = combine(estimates)
          return send({ id, type: "estimate", estimates, total, text: describeEstimate(total) })
        } catch (err) {
          if ((err as Error).message === ESTIMATE_CANCELLED) return send({ id, type: "cancelled" })
          throw err
        } finally {
          if (estimating.run === run) estimating.run = null
        }
      }
      case "opened":
        client.opened(String(msg.path))
        return send({ id, type: "ok" })
      case "semanticStatus":
        return send({ id, type: "semantic", status: semanticStatus(config, p.db) })
      case "semanticInstall": {
        // Semantic search's models. Apple may separately download speech assets on first use.
        // The app asks when it starts, unless semantic search was turned off.
        if (downloading.run) return send({ id, type: "error", error: "the model is already downloading" })
        downloading.run = new AbortController()
        try {
          await downloadModels({ signal: downloading.run.signal, onProgress: (d) => send({ type: "semanticDownload", ...d }) })
          config = validateConfigPatch(loadConfig(), { semantic: { enabled: true, declined: false }, defaultMode: "semantic" })
          saveConfig(config)
          client.setConfig(config)
        } catch (err) {
          if (downloading.run.signal.aborted) return send({ id, type: "cancelled" })
          throw err
        } finally {
          downloading.run = null
        }
        send({ id, type: "semantic", status: semanticStatus(config, p.db) })
        // Read the files for semantic search now: with a whole update when updates run on their
        // own, and with Only when I ask, a semantic-only run over the text already read. A run
        // going now has its settings from before: this one follows it.
        if (index) queue({ rebuild: false, background: true, meaningOnly: manualIndexing(config) })
        else startIndex(undefined, false, true, manualIndexing(config))
        return
      }
      case "semanticCancelInstall":
        downloading.run?.abort()
        return send({ id, type: "ok" })
      case "semanticRemove": {
        if (index || lockHolder(p.lock) !== null) return send({ id, type: "error", error: "indexing is running: stop it first" })
        config = validateConfigPatch(loadConfig(), { semantic: { enabled: false, declined: true }, defaultMode: "find" })
        saveConfig(config)
        client.setConfig(config)
        removeSemantic(p.db)
        return send({ id, type: "semantic", status: semanticStatus(config, p.db) })
      }
      default:
        return send({ id, type: "error", error: `unknown request type "${(msg as { type?: unknown }).type}"` })
    }
  }

  await client.waitReady()
  const stats = await client.stats()
  send({ type: "ready", version, files: stats?.stats.files ?? 0, firstRun, config })

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const inflight = new Set<Promise<void>>()
  for await (const line of lines) {
    if (!line.trim()) continue
    let msg: ServeIn
    try {
      msg = JSON.parse(line)
      if (typeof msg !== "object" || msg === null) throw new Error("expected a JSON object")
    } catch (e) {
      send({ type: "error", error: `bad request: ${(e as Error).message}` })
      continue
    }
    const task = handle(msg).catch((e) => send({ id: msg.id, type: "error", error: (e as Error).message }))
    inflight.add(task)
    void task.finally(() => inflight.delete(task))
  }
  // stdin closed: finish what was asked, stop indexing cleanly, and exit.
  closed = true
  downloading.run?.abort()
  estimating.run?.cancel()
  watcher.close()
  await Promise.all(inflight)
  if (index) {
    const run: IndexRun = index
    run.cancel()
    await Promise.race([run.done, new Promise((r) => setTimeout(r, 5000))])
    run.kill()
  }
  client.close()
  return 0
}
