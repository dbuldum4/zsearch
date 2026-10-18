import { type ClipboardService, type CliRenderer, createClipboard, createHostClipboard, createRendererClipboardAdapter } from "@opentui/core"
import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync } from "node:fs"
import { type Config, configExists, configStamp, type Paths, paths, loadConfig, saveConfig, configKeys, withConfigSetting } from "../config.ts"
import { IndexRun, type IndexOutcome, type IndexRunHandlers } from "../index/client.ts"
import { partialRunHolds } from "../index/db.ts"
import { estimateInBackground, type FolderEstimate } from "../index/estimate.ts"
import { RootWatcher } from "../index/watch.ts"
import { lockHolder } from "../index/lock.ts"
import { copyToClipboard, editorCommand, isTerminalEditor, openWithDefault, revealInFileManager } from "../platform.ts"
import { SearchClient, type StatsReply } from "../search/client.ts"
import type { Preview, SearchResponse } from "../search/engine.ts"
import type { Mode } from "../search/query.ts"
import { loadSearches, type RecentSearch, rememberSearch } from "../searches.ts"

export interface SearchService {
  search(query: string, mode: Mode, limit?: number): Promise<SearchResponse | null>
  preview(id: number, query: string, mode: Mode, focusLine?: number): Promise<Preview | null>
  stats(): Promise<StatsReply | null>
  refresh(force?: boolean): void
  setConfig(config: Config): void
  opened(path: string): void
  onRefreshed?: (files: number, changed: boolean) => void
  onRestart?: (reason: string) => void
  close(): void
}

export interface IndexHandle {
  done: Promise<IndexOutcome>
  cancel(): void
  /** Stop waiting on power (see `IndexRun.goNow`). */
  goNow?(): void
}

export interface Services {
  paths: Paths
  config: Config
  /** True when no config file exists yet (first run). */
  firstRun: boolean
  search: SearchService
  saveConfig(config: Config): void
  /** `background`: the run started on its own, and may wait on power (see `IndexRun`). */
  startIndex(config: Config, handlers: IndexRunHandlers, background?: boolean): IndexHandle
  /** PID of another process currently indexing, or null. */
  indexLockedBy(): number | null
  /** The run holding the index lock only updates changed paths: a run asked for waits for it. */
  partialRunHolds?(): boolean
  /** Count what a first index of these folders takes, in the background (setup). */
  estimate?(roots: string[], config: Config): { done: Promise<FolderEstimate[]>; cancel: () => void }
  open(path: string): Promise<string | null>
  reveal(path: string, isDir: boolean): Promise<string | null>
  /** Open in an editor; `suspend`/`resume` wrap terminal editors. */
  edit(path: string, line: number | undefined, suspend: () => Promise<void>, resume: () => Promise<void>): Promise<string | null>
  /** Copy to the clipboard. Resolves with where it went, or null if nowhere. */
  copy(text: string, renderer: CliRenderer): Promise<"host" | "terminal" | null>
  /** Keep a search a result was opened from, for Alt-↑/↓ (see src/searches.ts). */
  rememberSearch?(query: string, mode: Mode): void
  /** Searches kept by `rememberSearch`, here or in another frontend: newest first. */
  recentSearches?(): RecentSearch[]
  /** Release resources held by the services. */
  dispose?(): Promise<void>
}

const STOP_WAIT_MS = 15_000

export function realServices(config: Config): Services {
  const p = paths()
  let clipboard: ClipboardService | null = null
  const client = new SearchClient(p.db, config)
  client.keepSemanticReady()
  let baseline = structuredClone(config)
  let live: IndexRun | null = null
  // Every run this UI started, so quitting can stop them and let them kill their helpers.
  const runs = new Set<IndexRun>()
  /** Runs asked for that have not ended: file events wait for them, which may wait for the lock. */
  let asked = 0
  const track = (run: IndexRun) => {
    runs.add(run)
    void run.done.finally(() => runs.delete(run))
    return run
  }
  const watcher = new RootWatcher((changed) => {
    if (live || asked || lockHolder(p.lock) !== null) return false
    if (!configExists()) return
    const current = loadConfig(); client.setConfig(current)
    live = track(new IndexRun(current, p.db, p.lock, { onCommit: () => client.refresh() }, false, true, false, changed ?? undefined))
    void live.done.then((outcome) => { if (outcome.status !== "done") watcher.carryOver(changed) })
    void live.done.finally(() => { live = null; client.refresh(true) })
  })
  watcher.update(config)
  // Settings saved by another zsearch (the CLI, the Mac app) apply to the next search. The file
  // is read again only when it changed, not on every keystroke.
  let seen = configStamp()
  const reload = () => {
    const now = configStamp()
    if (now === seen) return
    seen = now
    if (!now) return
    const current = loadConfig(); client.setConfig(current); watcher.update(current)
  }
  const originalSearch = client.search.bind(client), originalPreview = client.preview.bind(client)
  client.search = (...args) => { reload(); return originalSearch(...args) }
  client.preview = (...args) => { reload(); return originalPreview(...args) }
  return {
    paths: p,
    config,
    firstRun: !configExists() || !existsSync(p.db),
    search: client,
    saveConfig: (next) => {
      let merged = loadConfig()
      const value = (c: Config, key: string) => key.split(".").reduce((v: any, k) => v[k], c)
      for (const key of configKeys()) if (JSON.stringify(value(next, key)) !== JSON.stringify(value(baseline, key))) merged = withConfigSetting(merged, key, value(next, key))
      saveConfig(merged); seen = configStamp(); baseline = structuredClone(merged); Object.assign(next, merged); watcher.update(merged)
    },
    startIndex: (cfg, handlers, background) => {
      const run = track(new IndexRun(configExists() ? loadConfig() : cfg, p.db, p.lock, handlers, false, background))
      if (!background) {
        asked++
        void run.done.finally(() => asked--)
      }
      return run
    },
    indexLockedBy: () => lockHolder(p.lock),
    partialRunHolds: () => partialRunHolds(p.db),
    estimate: estimateInBackground,
    open: openWithDefault,
    reveal: revealInFileManager,
    rememberSearch: (query, mode) => {
      // History is a convenience: a file it cannot write must not stop the file opening.
      try { rememberSearch(query, mode) } catch { /* not kept */ }
    },
    recentSearches: () => loadSearches().recent,
    async copy(text, renderer) {
      try {
        // OpenTUI's clipboard: native pasteboard/Wayland/X11, and OSC 52 for remote terminals.
        clipboard ??= createClipboard({ host: createHostClipboard(), terminal: createRendererClipboardAdapter(renderer) })
        const r = await clipboard.writeText(text, { destination: "best-available" })
        if (r.host.status === "written") return "host"
        if (r.terminal.status === "attempted") return "terminal"
      } catch {
        // fall back to command-line tools
      }
      return copyToClipboard(text) ? "host" : null
    },
    async dispose() {
      watcher.close()
      for (const run of runs) run.cancel()
      // A cancelled run stops between files; one stuck inside a single file is cut off.
      let timer: ReturnType<typeof setTimeout> | undefined
      const stopped = await Promise.race([
        Promise.all([...runs].map((run) => run.done)).then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), STOP_WAIT_MS) }),
      ])
      clearTimeout(timer)
      if (!stopped) for (const run of runs) run.kill()
      await clipboard?.dispose().catch(() => {})
      clipboard = null
    },
    edit: async (path, line, suspend, resume) => {
      let cmd: string[]
      try { cmd = editorCommand(loadConfig().editor, path, line) } catch (err) { return (err as Error).message }
      if (isTerminalEditor(cmd)) {
        await suspend()
        // In print mode stdout is a pipe (`vim "$(zsearch -p)"`): the editor needs the terminal.
        const opened: number[] = []
        const terminal = (stream: { isTTY?: boolean }, flags: "r" | "w"): "inherit" | number => {
          if (stream.isTTY) return "inherit"
          try { const fd = openSync("/dev/tty", flags); opened.push(fd); return fd } catch { return "inherit" }
        }
        try {
          const r = spawnSync(cmd[0]!, cmd.slice(1), { stdio: [terminal(process.stdin, "r"), terminal(process.stdout, "w"), terminal(process.stderr, "w")] })
          if (r.error) return r.error.message
        } finally {
          for (const fd of opened) closeSync(fd)
          await resume()
        }
        return null
      }
      return new Promise((resolve) => {
        const child = spawn(cmd[0]!, cmd.slice(1), { detached: true, stdio: "ignore" })
        child.on("error", (e) => resolve(`${cmd[0]}: ${e.message}`))
        child.on("spawn", () => {
          child.unref()
          resolve(null)
        })
      })
    },
  }
}
