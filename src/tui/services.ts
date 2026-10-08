import { type ClipboardService, type CliRenderer, createClipboard, createHostClipboard, createRendererClipboardAdapter } from "@opentui/core"
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { type Config, configExists, type Paths, paths, saveConfig } from "../config.ts"
import { IndexRun, type IndexOutcome, type IndexRunHandlers } from "../index/client.ts"
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
}

export interface Services {
  paths: Paths
  config: Config
  /** True when no config file exists yet (first run). */
  firstRun: boolean
  search: SearchService
  saveConfig(config: Config): void
  startIndex(config: Config, handlers: IndexRunHandlers): IndexHandle
  /** PID of another process currently indexing, or null. */
  indexLockedBy(): number | null
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
  return {
    paths: p,
    config,
    firstRun: !configExists() || !existsSync(p.db),
    search: client,
    saveConfig,
    startIndex: (cfg, handlers) => new IndexRun(cfg, p.db, p.lock, handlers),
    indexLockedBy: () => lockHolder(p.lock),
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
      await clipboard?.dispose().catch(() => {})
      clipboard = null
    },
    edit: async (path, line, suspend, resume) => {
      const cmd = editorCommand(config.editor, path, line)
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
