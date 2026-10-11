import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export interface ContentConfig {
  /** Extract and index text inside files. */
  enabled: boolean
  /** Largest document (PDF, Office, ...) to open, in MB. */
  maxDocumentMB: number
  /** Largest plain-text/code file to read, in MB. */
  maxTextMB: number
  /** Extracted text kept per file, in characters. */
  maxChars: number
  metadata: boolean
  /** Read the text in images and scanned PDF pages, where the OCR helper is available (Mac app). */
  ocr: boolean
}

export interface Config {
  /** Folders to index. `~` is expanded. */
  roots: string[]
  /** Extra gitignore-style patterns to skip everywhere. */
  exclude: string[]
  /** Folders whose files are indexed by name only (no contents). */
  namesOnly: string[]
  /** Index dotfiles and dot-folders. */
  includeHidden: boolean
  /** Honour .gitignore / .ignore / .zsearchignore files. */
  respectGitignore: boolean
  /** Follow symbolic links to folders. */
  followSymlinks: boolean
  /** Do not descend into other mounted file systems. */
  oneFileSystem: boolean
  /** Read contents inside cloud-synced folders (iCloud Drive, CloudStorage); may download files. */
  cloudContent: boolean
  content: ContentConfig
  /** Refresh the index in the background when it is older than this (0 = never). */
  autoRefreshMinutes: number
  liveUpdates: boolean
  /** Extraction worker threads (0 = automatic). */
  workers: number
  /**
   * How much of the computer indexing may use, in percent: of its cores (with `workers` at 0)
   * and of its CPU time. Below 100, indexing also reads and writes at a low disk priority.
   */
  indexLoad: number
  /** Command used to open files in an editor (defaults to $VISUAL / $EDITOR). */
  editor: string
  /** Default search mode in the TUI. */
  defaultMode: "find" | "fuzzy"
  /** Show the preview pane by default. */
  preview: boolean
}

/** Indexed unless the user picks something else: where people keep and receive documents. */
export const DEFAULT_ROOTS = ["~/Documents", "~/Downloads"]

export function defaultConfig(): Config {
  return {
    roots: [...DEFAULT_ROOTS],
    exclude: [],
    namesOnly: [],
    includeHidden: false,
    respectGitignore: true,
    followSymlinks: false,
    oneFileSystem: false,
    cloudContent: false,
    content: { enabled: true, metadata: false, maxDocumentMB: 64, maxTextMB: 8, maxChars: 2_000_000, ocr: true },
    autoRefreshMinutes: 60,
    liveUpdates: true,
    workers: 0,
    indexLoad: 70,
    editor: "",
    defaultMode: "find",
    preview: true,
  }
}

export function home(): string {
  return process.env.HOME || homedir()
}

function expandHome(p: string): string {
  if (p === "~") return home()
  if (p.startsWith("~/")) return join(home(), p.slice(2))
  return p
}

export function resolvePath(p: string): string {
  return resolve(expandHome(p))
}

/** Pretty-print a path relative to the home folder. */
export function tildify(p: string): string {
  const h = home()
  if (p === h) return "~"
  if (h !== "/" && p.startsWith(h + "/")) return "~" + p.slice(h.length)
  return p
}

export interface Paths {
  config: string
  configFile: string
  data: string
  db: string
  lock: string
}

export function paths(): Paths {
  const override = process.env.ZSEARCH_HOME
  const h = home()
  let config: string, data: string
  if (override) {
    config = data = resolve(override)
  } else {
    config = join(process.env.XDG_CONFIG_HOME || join(h, ".config"), "zsearch")
    if (process.platform === "darwin" && !process.env.XDG_DATA_HOME) {
      data = join(h, "Library", "Application Support", "zsearch")
    } else {
      data = join(process.env.XDG_DATA_HOME || join(h, ".local", "share"), "zsearch")
    }
  }
  return {
    config,
    configFile: join(config, "config.json"),
    data,
    db: process.env.ZSEARCH_DB ? resolve(process.env.ZSEARCH_DB) : join(data, "index.db"),
    lock: join(data, "index.lock"),
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Validation shared by the CLI, app and MCP. */
const CONFIG_RULES: Record<string, (v: unknown) => string | null> = {
  defaultMode: (v) => v === "find" || v === "fuzzy" ? null : 'must be "find" or "fuzzy"',
  indexLoad: (v) => Number.isInteger(v) && Number(v) >= 10 && Number(v) <= 100 ? null : "must be a whole number from 10 to 100 (percent)",
  workers: (v) => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 64 ? null : "must be a whole number from 0 (automatic) to 64",
  autoRefreshMinutes: (v) => Number.isFinite(v) && Number(v) >= 0 ? null : "must be 0 (off) or more",
  "content.maxDocumentMB": (v) => Number.isFinite(v) && Number(v) > 0 ? null : "must be more than 0",
  "content.maxTextMB": (v) => Number.isFinite(v) && Number(v) > 0 ? null : "must be more than 0",
  "content.maxChars": (v) => Number.isInteger(v) && Number(v) > 0 ? null : "must be a whole number above 0",
}

export function configKeys(): string[] {
  const out: string[] = []
  const walk = (o: Record<string, unknown>, prefix = "") => {
    for (const [k, v] of Object.entries(o)) {
      if (isObject(v)) walk(v, `${prefix}${k}.`)
      else out.push(prefix + k)
    }
  }
  walk(defaultConfig() as unknown as Record<string, unknown>)
  return out
}

/** Convert and validate one setting without mutating the caller's copy. */
export function withConfigSetting(config: Config, key: string, raw: unknown): Config {
  if (!configKeys().includes(key)) throw new Error(`unknown config key: ${key}`)
  const parts = key.split(".")
  const next = structuredClone(config)
  const parent = parts.slice(0, -1).reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, next as unknown as Record<string, unknown>)
  const last = parts.at(-1)!
  const cur = parent[last]
  let value = raw
  if (Array.isArray(cur)) {
    if (typeof raw === "string") {
      try { value = raw.trim().startsWith("[") ? JSON.parse(raw) : raw.split(",") }
      catch { throw new Error(`${key} expects a list of strings`) }
    }
    if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) throw new Error(`${key} expects a list of strings`)
    value = value.map((s: string) => s.trim()).filter(Boolean)
  } else if (typeof cur === "boolean") {
    if (typeof raw === "string" && /^(true|false|1|0|yes|no|on|off)$/i.test(raw)) value = /^(true|1|yes|on)$/i.test(raw)
    if (typeof value !== "boolean") throw new Error(`${key} expects true or false`)
  } else if (typeof cur === "number") {
    if (typeof raw === "string" && raw.trim()) value = Number(raw)
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} expects a number`)
  } else if (typeof value !== typeof cur) throw new Error(`${key} expects a ${typeof cur}`)
  const problem = CONFIG_RULES[key]?.(value)
  if (problem) throw new Error(`${key} ${problem}`)
  parent[last] = value
  return next
}

/** Reject invalid app patches rather than silently saving unusable settings. */
export function validateConfigPatch(base: Config, patch: unknown): Config {
  if (!isObject(patch)) throw new Error("expected a settings object")
  let out = structuredClone(base)
  const walk = (o: Record<string, unknown>, prefix = "") => {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix + k
      if (isObject(v) && configKeys().some((s) => s.startsWith(key + "."))) walk(v, `${key}.`)
      else if (configKeys().includes(key)) out = withConfigSetting(out, key, v)
    }
  }
  walk(patch)
  return out
}

/** Deep-merge a partial user config onto defaults, ignoring unknown or ill-typed keys. */
export function mergeConfig(base: Config, patch: unknown): Config {
  const out = structuredClone(base) as unknown as Record<string, unknown>
  if (!isObject(patch)) return out as unknown as Config
  const walk = (dst: Record<string, unknown>, src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src)) {
      if (!(k in dst)) continue
      const cur = dst[k]
      if (isObject(cur) && isObject(v)) walk(cur, v)
      else if (Array.isArray(cur) && Array.isArray(v)) dst[k] = v.filter((x) => typeof x === "string")
      else if (typeof cur === typeof v) dst[k] = v
    }
  }
  walk(out, patch)
  // Older versions had auto, exact, regex and semantic modes: all of them are "find" now.
  if (out.defaultMode !== "fuzzy") out.defaultMode = "find"
  return out as unknown as Config
}

export function configExists(): boolean {
  return existsSync(paths().configFile)
}

export function loadConfig(): Config {
  const file = paths().configFile
  if (!existsSync(file)) return defaultConfig()
  try {
    return mergeConfig(defaultConfig(), JSON.parse(readFileSync(file, "utf8")))
  } catch (err) {
    process.emitWarning(`zsearch: ignoring unreadable config ${file}: ${(err as Error).message}`)
    return defaultConfig()
  }
}

export function saveConfig(config: Config): void {
  const file = paths().configFile
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  chmodSync(dirname(file), 0o700)
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  renameSync(tmp, file)
}

/** Set a dotted key (e.g. "content.enabled") from a CLI string value. */
export function setConfigValue(config: Config, key: string, raw: string): Config {
  return withConfigSetting(config, key, raw)
}

export function ensureDirs(): Paths {
  const p = paths()
  mkdirSync(p.data, { recursive: true, mode: 0o700 })
  mkdirSync(p.config, { recursive: true, mode: 0o700 })
  chmodSync(p.data, 0o700)
  chmodSync(p.config, 0o700)
  if (existsSync(p.configFile)) chmodSync(p.configFile, 0o600)
  return p
}
