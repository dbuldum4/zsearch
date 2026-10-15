import { type ClipboardService, type CliRenderer, createClipboard, createHostClipboard, createRendererClipboardAdapter } from "@opentui/core"
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { type Config, configExists, configStamp, type Paths, paths, loadConfig, saveConfig, configKeys, withConfigSetting } from "../config.ts"
import { IndexRun, type IndexOutcome, type IndexRunHandlers } from "../index/client.ts"
import { estimateInBackground, type FolderEstimate } from "../index/estimate.ts"
import { RootWatcher } from "../index/watch.ts"
import { lockHolder } from "../index/lock.ts"
import { copyToClipboard, editorCommand, isTerminalEditor, openWithDefault, revealInFileManager } from "../platform.ts"
import { SearchClient, type StatsReply } from "../search/client.ts"
import type { Preview, SearchResponse } from "../search/engine.ts"
import type { Mode } from "../search/query.ts"

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
  /** Count what a first index of these folders takes, in the background (setup). */
  estimate?(roots: string[], config: Config): { done: Promise<FolderEstimate[]>; cancel: () => void }
  open(path: string): Promise<string | null>
  reveal(path: string, isDir: boolean): Promise<string | null>
  /** Open in an editor; `suspend`/`resume` wrap terminal editors. */
  edit(path: string, line: number | undefined, suspend: () => Promise<void>, resume: () => Promise<void>): Promise<string | null>
  /** Copy to the clipboard. Resolves with where it went, or null if nowhere. */
  copy(text: string, renderer: CliRenderer): Promise<"host" | "terminal" | null>
  /** Release resources held by the services. */
  dispose?(): Promise<void>
}

export function realServices(config: Config): Services {
  const p = paths()
  let clipboard: ClipboardService | null = null
  const client = new SearchClient(p.db, config)
  let baseline = structuredClone(config)
  let live: IndexRun | null = null
  const watcher = new RootWatcher(() => {
    if (live || lockHolder(p.lock) !== null) return false
    if (!configExists()) return
    const current = loadConfig(); client.setConfig(current)
    live = new IndexRun(current, p.db, p.lock, { onCommit: () => client.refresh() }, false, true)
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
    startIndex: (cfg, handlers, background) => new IndexRun(configExists() ? loadConfig() : cfg, p.db, p.lock, handlers, false, background),
    indexLockedBy: () => lockHolder(p.lock),
    estimate: estimateInBackground,
    open: openWithDefault,
    reveal: revealInFileManager,
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
      live?.cancel()
      if (live) await live.done
      await clipboard?.dispose().catch(() => {})
      clipboard = null
    },
    edit: async (path, line, suspend, resume) => {
      let cmd: string[]
      try { cmd = editorCommand(loadConfig().editor, path, line) } catch (err) { return (err as Error).message }
      if (isTerminalEditor(cmd)) {
        await suspend()
        try {
          const r = spawnSync(cmd[0]!, cmd.slice(1), { stdio: "inherit" })
          if (r.error) return r.error.message
        } finally {
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
