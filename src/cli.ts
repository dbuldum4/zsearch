import { combine, describeEstimate, estimateFolders } from "./index/estimate.ts"
import { progressLine } from "./util/progress.ts"
export { progressLine } from "./util/progress.ts"
import { existsSync, rmSync } from "node:fs"
import { Database } from "bun:sqlite"
import pkg from "../package.json" with { type: "json" }
import {
  type Config,
  configExists,
  DEFAULT_ROOTS,
  defaultConfig,
  ensureDirs,
  loadConfig,
  paths,
  resolvePath,
  saveConfig,
  setConfigValue,
  tildify,
} from "./config.ts"
import { clearIndex, getMeta, indexStats, openDb } from "./index/db.ts"
import { excludingPath } from "./index/exclude.ts"
import { duplicateFiles } from "./search/duplicates.ts"
import { Indexer, type IndexProgress } from "./index/indexer.ts"
import { acquireLock, lockHolder } from "./index/lock.ts"
import { KIND_BADGE } from "./kinds.ts"
import { ocrToolPath, pdftotextPath } from "./platform.ts"
import { SearchEngine, type SearchHit } from "./search/engine.ts"
import { MODES, type Mode } from "./search/query.ts"
import { formatAge, formatBytes, formatCount, formatDuration } from "./util/text.ts"
import { embedToolPath } from "./semantic/helper.ts"
import { runSemanticPass, semanticAvailable } from "./semantic/indexer.ts"
import { removeSemantic, semanticStatus } from "./semantic/manage.ts"
import { downloadModels, GRANITE, modelBytes } from "./semantic/model.ts"
import { semanticDbPath } from "./semantic/store.ts"

export const VERSION: string = pkg.version

const HELP = `zsearch ${VERSION} — fast search for your files (names and contents)

Usage
  zsearch [query]                 open the interactive search
  zsearch search <query>          print matches and exit
  zsearch index [folders...]      build or update the index
  zsearch status                  show what is indexed
  zsearch config [get|set|path|reset] [key] [value]
  zsearch estimate [folders...]   how long a first index takes, roughly (--docs|--home|--disk)
  zsearch duplicates [--json]      find identical indexed files
  zsearch exclude <path>          exclude an indexed file or folder
  zsearch semantic [status|install|remove]  semantic search (downloads Granite)
  zsearch doctor                  check optional tools and the index
  zsearch reset                   delete the index
  zsearch serve                   JSON lines on stdin/stdout (for the macOS app)
  zsearch mcp                     MCP server on stdin/stdout (for Claude and other AI apps)

Interactive options
  -m, --mode <mode>   start in find (default) | fuzzy | semantic
  -p, --print         print the chosen path instead of opening it
                      (e.g.  vim "$(zsearch -p)")
      --no-preview    start with the preview pane hidden

Search options
  -m, --mode <mode>   find (default) | fuzzy | semantic
  -e, --regex         treat the query as a regular expression
  -n, --limit <n>     maximum results (default 20)
  -l, --files         print paths only
  -0                  NUL-separated paths
      --csv           CSV output
      --sort <key>    name, size, date, path (prefix - for descending)
      --json          JSON output
      --no-color      disable colors

Index options
      --docs          index ~/Documents and ~/Downloads (default)
      --home          index your whole home folder
      --disk          index the entire disk
      --hidden        include hidden files    (--no-hidden to exclude)
      --no-content    index names only
      --rebuild       start from an empty index
      --semantic-only build only the Granite semantic index, from text already read;
                      skips scanning and the word index
  -q, --quiet         no progress output

Query syntax
  text                find: this exact text in file names and contents
                      (smart case: lowercase ignores case)
  /regex/  re:...     find with a regular expression
  f:...               fuzzy: fzf-style names, typo-tolerant contents
  s:...               semantic: by meaning (zsearch semantic install)
  ext:pdf,docx  type:doc|sheet|slides|code|image|folder  in:~/Documents
  path:2024  size:>5mb  mtime:<7d  after:2024-01-01  limit:50

Files
  config  ${tildify(paths().configFile)}
  index   ${tildify(paths().db)}
`

interface Args {
  _: string[]
  flags: Map<string, string | boolean>
}

const VALUE_FLAGS = new Set(["mode", "m", "limit", "n", "sort"])

export function parseArgs(argv: string[]): Args {
  const _: string[] = []
  const flags = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--") {
      _.push(...argv.slice(i + 1))
      break
    }
    if (a === "-0") { flags.set("0", true); continue }
    if (/^-[a-z]+:/.test(a)) { _.push(a); continue }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1))
      else if (a.startsWith("--no-")) flags.set(a.slice(5), false)
      else if (VALUE_FLAGS.has(a.slice(2)) && i + 1 < argv.length) flags.set(a.slice(2), argv[++i]!)
      else flags.set(a.slice(2), true)
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const f = a[j]!
        if (VALUE_FLAGS.has(f) && j === a.length - 1 && i + 1 < argv.length) flags.set(f, argv[++i]!)
        else flags.set(f, true)
      }
    } else _.push(a)
  }
  return { _, flags }
}

function flag(args: Args, ...names: string[]): string | boolean | undefined {
  for (const n of names) if (args.flags.has(n)) return args.flags.get(n)
  return undefined
}

function parseMode(v: string | boolean | undefined): Mode | undefined {
  if (typeof v !== "string") return undefined
  const m = v.toLowerCase() as Mode
  if (!MODES.includes(m)) throw new UsageError(`unknown mode "${v}" (use ${MODES.join(", ")})`)
  return m
}

class UsageError extends Error {}

const color = (on: boolean) => {
  const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s)
  return { bold: wrap("1"), dim: wrap("2"), cyan: wrap("36"), yellow: wrap("33"), green: wrap("32"), red: wrap("31"), match: wrap("1;33"), magenta: wrap("35") }
}

export async function main(argv: string[]): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (e) {
    console.error(`zsearch: ${(e as Error).message}`)
    return 2
  }
  if (flag(args, "help", "h")) {
    process.stdout.write(commandHelp(args._[0]))
    return 0
  }
  if (flag(args, "version", "v")) {
    console.log(VERSION)
    return 0
  }
  const [cmd, ...rest] = args._
  try {
    switch (cmd) {
      case "search":
      case "s":
        return await cmdSearch(rest.join(" "), args)
      case "index":
      case "i":
        return await cmdIndex(rest, args)
      case "exclude": {
        if (!rest.length) throw new UsageError("exclude needs an indexed path")
        const db = openDb(paths().db)
        try { saveConfig(excludingPath(db, loadConfig(), rest.join(" "))) } finally { db.close() }
        return await cmdIndex([], args)
      }
      case "duplicates": {
        const db = openDb(paths().db)
        try {
          const result = await duplicateFiles(db, loadConfig())
          if (flag(args, "json")) console.log(JSON.stringify(result, null, 2))
          else for (const group of result.groups) console.log(`${formatBytes(group.size)} each\n${group.paths.join("\n")}\n`)
          if (result.partial) console.error("Duplicate scan reached its time budget; some files were not checked.")
          return 0
        } finally { db.close() }
      }
      case "status":
        return cmdStatus(args)
      case "estimate":
        return cmdEstimate(rest, args)
      case "config":
        return cmdConfig(rest)
      case "reset":
        return cmdReset()
      case "doctor":
        return cmdDoctor()
      case "semantic":
        return await cmdSemantic(rest, args)
      case "serve": {
        const { serve } = await import("./serve.ts")
        return await serve(VERSION)
      }
      case "mcp": {
        const { mcp } = await import("./mcp/server.ts")
        return await mcp(VERSION)
      }
      case "help":
        process.stdout.write(HELP)
        return 0
      default:
        return await cmdTui(args._.join(" "), args)
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`zsearch: ${e.message}`)
      return 2
    }
    console.error(`zsearch: ${(e as Error).message}`)
    return 1
  }
}

/* -------------------------------------------------------------------- tui -- */

async function cmdTui(query: string, args: Args): Promise<number> {
  const mode = parseMode(flag(args, "mode", "m"))
  const config = loadConfig()
  if (flag(args, "preview") === false) config.preview = false
  const { runTui } = await import("./tui/run.tsx")
  const selection = await runTui({ config, query, mode, print: flag(args, "print", "p") === true })
  if (selection) process.stdout.write(selection + "\n")
  return 0
}

/* ----------------------------------------------------------------- search -- */

async function cmdSearch(query: string, args: Args): Promise<number> {
  if (!query.trim()) throw new UsageError("search needs a query, e.g. zsearch search budget ext:xlsx")
  const p = paths()
  if (!existsSync(p.db)) {
    console.error("zsearch: no index yet — run `zsearch index` first")
    return 2
  }
  const mode = parseMode(flag(args, "mode", "m")) ?? "find"
  if (flag(args, "regex", "e") === true) query = `re:${query}`
  if (typeof flag(args, "sort") === "string") query += ` sort:${flag(args, "sort")}`
  const limitFlag = flag(args, "limit", "n")
  const limit = typeof limitFlag === "string" ? Math.max(1, Number(limitFlag) || 20) : 20
  const db = openDb(p.db)
  const engine = new SearchEngine(db, loadConfig())
  const res = await engine.search(query, mode, { limit, budgetMs: 10_000 })
  engine.closeSemantic()
  db.close()
  if (flag(args, "json")) {
    console.log(JSON.stringify({ ...res, hits: res.hits.map(jsonHit) }, null, 2))
    return res.error ? 2 : res.hits.length ? 0 : 1
  }
  if (res.error) {
    console.error(`zsearch: ${res.error}`)
    return 2
  }
  const c = color(process.stdout.isTTY === true && flag(args, "color") !== false && !process.env.NO_COLOR)
  if (flag(args, "0")) {
    process.stdout.write(res.hits.map((h) => h.path + "\0").join(""))
    return res.hits.length ? 0 : 1
  }
  if (flag(args, "csv")) {
    const cell = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`
    console.log("path,kind,size,mtime,match_count")
    for (const h of res.hits) console.log([h.path, h.kind, h.size, new Date(h.mtime).toISOString(), h.matchCount].map(cell).join(","))
    return res.hits.length ? 0 : 1
  }
  if (flag(args, "files", "l")) {
    for (const h of res.hits) console.log(h.path)
    return res.hits.length ? 0 : 1
  }
  for (const h of res.hits) {
    const badge = c.magenta(KIND_BADGE[h.kind].padEnd(4))
    const nameStart = h.display.lastIndexOf("/") + 1
    const shown = highlightPositions(h.display, h.namePositions, c.match, nameStart, c.bold)
    console.log(`${badge} ${shown}${h.isDir ? "/" : ""}  ${c.dim(`${h.isDir ? "" : formatBytes(h.size) + " · "}${formatAge(h.mtime)}`)}`)
    for (const l of h.lines.slice(0, 3)) {
      const loc = ["pdf", "slides", "ebook"].includes(h.kind) ? `p${l.page}` : `${l.line}`
      console.log(`     ${c.green(loc.padStart(5))}: ${highlightRanges(l.text, l.ranges, c.match)}`)
    }
  }
  const summary = `${formatCount(res.hits.length)} of ${formatCount(res.total)} results · ${res.strategy} · ${formatDuration(res.elapsedMs)}${res.partial ? " · partial (search budget)" : ""}`
  if (process.stderr.isTTY) console.error(c.dim(summary))
  if (res.notice) console.error(c.yellow(res.notice))
  return res.hits.length ? 0 : 1
}

function jsonHit(h: SearchHit) {
  return { path: h.path, kind: h.kind, isDir: h.isDir, size: h.size, mtime: new Date(h.mtime).toISOString(), score: h.score, sources: h.sources, lines: h.lines, matchCount: h.matchCount }
}

function highlightPositions(s: string, pos: number[], hi: (s: string) => string, boldFrom: number, bold: (s: string) => string): string {
  const set = new Set(pos)
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    out += set.has(i) ? hi(ch) : i >= boldFrom ? bold(ch) : ch
  }
  return out
}

function highlightRanges(s: string, ranges: [number, number][], hi: (s: string) => string): string {
  let out = ""
  let pos = 0
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a < pos) continue
    out += s.slice(pos, a) + hi(s.slice(a, b))
    pos = b
  }
  return out + s.slice(pos)
}

/* ------------------------------------------------------------------ index -- */

async function cmdIndex(folders: string[], args: Args): Promise<number> {
  ensureDirs()
  const p = paths()
  const config = loadConfig()
  let save = !configExists()
  if (flag(args, "disk")) {
    config.roots = ["/"]
    save = true
  } else if (flag(args, "docs")) {
    config.roots = [...DEFAULT_ROOTS]
    save = true
  } else if (flag(args, "home")) {
    config.roots = ["~"]
    save = true
  } else if (folders.length) {
    for (const f of folders) if (!existsSync(resolvePath(f))) throw new UsageError(`no such folder: ${f}`)
    config.roots = folders.map((f) => tildify(resolvePath(f)))
    save = true
  }
  const hidden = flag(args, "hidden")
  if (typeof hidden === "boolean") {
    config.includeHidden = hidden
    save = true
  }
  if (flag(args, "content") === false) {
    config.content.enabled = false
    save = true
  }
  if (save) saveConfig(config)
  const release = acquireLock(p.lock)
  if (!release) {
    const waiting = existsSync(p.db) ? waitingFor(p.db) : ""
    console.error(`zsearch: another zsearch process (pid ${lockHolder(p.lock)}) is updating the index${waiting ? ` (waiting: ${waiting}; Update Index Now in the app, or Ctrl-R in zsearch, starts it at once)` : ""}`)
    return 1
  }
  const onSignal = () => controller.abort()
  const controller = new AbortController()
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  // --meaning-only: its name before semantic search was called that.
  const meaningOnly = flag(args, "semantic-only", "meaning-only") === true
  if (meaningOnly && flag(args, "rebuild")) throw new UsageError("--semantic-only cannot be combined with --rebuild")
  try {
    // Refuse a semantic-only run before opening (and thereby creating) the index.
    const tool = embedToolPath()
    const blocked = semanticAvailable(config, tool)
    if (meaningOnly && blocked) {
      console.error(`zsearch: semantic search cannot run: ${blocked}`)
      return 1
    }
    const db = openDb(p.db)
    // Emptied in place rather than deleted: frontends may have the database open.
    if (flag(args, "rebuild")) clearIndex(db)
    const quiet = flag(args, "quiet", "q") === true
    const tty = process.stderr.isTTY === true
    let lastLine = Date.now()
    const report = (pr: IndexProgress) => {
      if (quiet) return
      const line = progressLine(pr)
      if (tty) process.stderr.write(`\r\x1b[2K${line.slice(0, (process.stderr.columns || 100) - 1)}`)
      else if (Date.now() - lastLine > 2000 && pr.phase !== "done") {
        process.stderr.write(line + "\n")
        lastLine = Date.now()
      }
    }
    if (!quiet) console.error(meaningOnly ? "Building the Granite semantic index from text already read…" : `Indexing ${config.roots.join(", ")}…`)
    const startedAt = Date.now()
    let result: IndexProgress = { phase: "done", scanned: 0, added: 0, updated: 0, removed: 0, contentTotal: 0, contentDone: 0, contentBytes: 0, contentErrors: 0, current: "", startedAt, elapsedMs: 0 }
    if (!meaningOnly) result = await new Indexer(db, config, { onProgress: report, signal: controller.signal }).run()
    // Semantic search, when it is on: embed what this run read.
    if (result.phase === "done" && !blocked) {
      const base = result.elapsedMs
      const started = Date.now()
      const summary = await runSemanticPass(db, config, tool, {
        signal: controller.signal,
        onProgress: (m) => report({ ...result, phase: "meaning", current: m.current, waiting: m.waiting, meaning: m }),
      })
      result.elapsedMs = base + Date.now() - started
      result.meaning = { total: summary.files, done: summary.files, embedded: summary.embedded, reused: summary.reused, error: summary.error }
      if (summary.status === "cancelled") result.phase = "cancelled"
    }
    if (tty && !quiet) process.stderr.write("\r\x1b[2K")
    const stats = indexStats(db, p.db)
    db.close()
    if (result.phase === "error") {
      console.error(`zsearch: indexing failed: ${result.error}`)
      return 1
    }
    if (result.phase === "cancelled") {
      console.error("Indexing cancelled; the partial index is still searchable.")
      return 130
    }
    if (!quiet) {
      console.error(
        `Done in ${formatDuration(result.elapsedMs)}: ${formatCount(result.scanned)} items scanned, ${formatCount(result.added)} new, ${formatCount(result.updated)} changed, ${formatCount(result.removed)} removed.`,
      )
      console.error(`Index: ${formatCount(stats.files)} files, ${formatCount(stats.folders)} folders, ${formatCount(stats.withContent)} with text (${formatBytes(stats.contentBytes)}), ${formatBytes(stats.dbBytes)} on disk.`)
      if (result.unreadableFolders) console.error(`Could not read ${result.unreadableFolders} folders (check permissions); their indexed files were kept.`)
      if (result.contentErrors) console.error(`${formatCount(result.contentErrors)} files could not be read (see \`zsearch status --errors\`).`)
      const m = result.meaning
      if (m?.error) console.error(`Semantic indexing stopped: ${m.error}`)
      else if (m) console.error(`Semantic: ${formatCount(m.done)} files read, ${formatCount(m.embedded)} passages embedded, ${formatCount(m.reused)} reused.`)
    }
    return 0
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    release()
  }
}

/* --------------------------------------------------------------- estimate -- */

function cmdEstimate(folders: string[], args: Args): number {
  const config = loadConfig()
  const roots = flag(args, "disk") ? ["/"] : flag(args, "home") ? ["~"] : flag(args, "docs") ? [...DEFAULT_ROOTS] : folders.length ? folders : config.roots
  for (const f of roots) if (!existsSync(resolvePath(f))) throw new UsageError(`no such folder: ${f}`)
  const estimates = estimateFolders(roots, config)
  if (flag(args, "json")) {
    console.log(JSON.stringify(estimates, null, 2))
    return 0
  }
  const width = Math.max(...roots.map((r) => r.length))
  for (const e of estimates) {
    const parts = [`${formatCount(e.textFiles)} text`, `${formatCount(e.documents)} documents`, ...(e.ocrImages ? [`${formatCount(e.ocrImages)} images to OCR`] : [])]
    console.log(`${e.root.padEnd(width)}  ${describeEstimate(e)}  (${parts.join(", ")})`)
  }
  if (estimates.length > 1) console.log(`${"All".padEnd(width)}  ${describeEstimate(combine(estimates))}`)
  if (estimates.some((e) => !e.complete)) console.log("The count stopped early in large folders: times there are a lower bound.")
  return 0
}

/** Why the run holding the index lock waits on power, if it does. */
function waitingFor(dbPath: string): string {
  try {
    const db = openDb(dbPath, { readonly: true })
    try { return getMeta(db, "waiting_for") ?? "" } finally { db.close() }
  } catch { return "" }
}

/* ----------------------------------------------------------------- status -- */

function cmdStatus(args: Args): number {
  const p = paths()
  const config = loadConfig()
  if (!existsSync(p.db)) {
    console.log("No index yet. Run `zsearch` or `zsearch index` to build one.")
    return 1
  }
  const db = openDb(p.db)
  const s = indexStats(db, p.db)
  if (flag(args, "json")) {
    console.log(JSON.stringify(s, null, 2))
    db.close()
    return 0
  }
  console.log(`Index        ${tildify(p.db)} (${formatBytes(s.dbBytes)})`)
  console.log(`Folders      ${(s.roots.length ? s.roots : config.roots).map(tildify).join(", ")}`)
  console.log(`Files        ${formatCount(s.files)} files, ${formatCount(s.folders)} folders`)
  console.log(`Contents     ${formatCount(s.withContent)} files with text (${formatBytes(s.contentBytes)}), ${formatCount(s.skipped)} skipped, ${formatCount(s.errors)} unreadable, ${formatCount(s.pending)} pending`)
  console.log(`Updated      ${s.lastIndexedAt ? `${formatAge(s.lastIndexedAt)} (took ${formatDuration(s.lastDurationMs ?? 0)})` : "never completed"}`)
  if (s.unreadableFolders?.length) console.log(`Could not read ${s.unreadableFolders.length} folders (check permissions); indexed files were kept.`)
  if (s.secrets) console.log(`Not read     ${formatCount(s.secrets)} key or password files, indexed by name only`)
  if (s.datasetImages) console.log(`No OCR       ${formatCount(s.datasetImages)} images in ${formatCount(s.datasetFolders.length)} machine-made dataset folders (\`zsearch config set skipDatasetOcr false\` reads them)`)
  if (config.semantic.enabled) {
    const sem = semanticStatus(config, p.db)
    const i = sem.index
    console.log(`Semantic     ${sem.blocked ? `off: ${sem.blocked}` : i ? `${formatCount(i.files)} files, ${formatCount(i.vectors)} vectors (${formatBytes(i.bytes)})${i.partial ? `, ${formatCount(i.partial)} long files to finish` : ""}${i.error ? `; last run failed: ${i.error}` : ""}` : "not read yet (with the next index update)"}`)
  }
  const holder = lockHolder(p.lock)
  if (holder) {
    const waiting = getMeta(db, "waiting_for")
    console.log(`Indexing     in progress (pid ${holder})${waiting ? `, waiting: ${waiting}` : ""}`)
  }
  if (flag(args, "errors")) {
    const rows = db.query("SELECT path, note FROM files WHERE content_state = 2 ORDER BY path LIMIT 200").all() as { path: string; note: string }[]
    console.log(rows.length ? "\nUnreadable files:" : "\nNo unreadable files.")
    for (const r of rows) console.log(`  ${tildify(r.path)}: ${r.note}`)
    const secrets = db.query("SELECT path FROM files WHERE content_state = 3 AND note = 'secret' ORDER BY path LIMIT 200").values() as [string][]
    if (secrets.length) console.log("\nKey or password files (indexed by name only):")
    for (const [path] of secrets) console.log(`  ${tildify(path)}`)
    const datasets = s.datasetImages ? s.datasetFolders : []
    if (datasets.length) console.log("\nDataset folders (images not read with OCR):")
    for (const f of datasets) console.log(`  ${tildify(f.dir)}: ${formatCount(f.images)} images`)
  }
  db.close()
  return 0
}

/* ----------------------------------------------------------------- config -- */

function cmdConfig(rest: string[]): number {
  const [action, key, ...valueParts] = rest
  const p = paths()
  switch (action) {
    case undefined:
    case "show":
      console.log(JSON.stringify(loadConfig(), null, 2))
      return 0
    case "path":
      console.log(p.configFile)
      return 0
    case "get": {
      if (!key) throw new UsageError("config get <key>")
      let v: unknown = loadConfig()
      for (const part of key.split(".")) v = (v as Record<string, unknown>)?.[part]
      if (v === undefined) throw new UsageError(`unknown config key: ${key}`)
      console.log(typeof v === "string" ? v : JSON.stringify(v))
      return 0
    }
    case "set": {
      if (!key || !valueParts.length) throw new UsageError("config set <key> <value>")
      let config: Config
      try {
        config = setConfigValue(loadConfig(), key, valueParts.join(" "))
      } catch (e) {
        throw new UsageError((e as Error).message)
      }
      saveConfig(config)
      console.log(`${key} = ${JSON.stringify(key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], config))}`)
      if (/^(roots|exclude|namesOnly|includeHidden|respectGitignore|content)/.test(key)) console.log("Run `zsearch index` (or press Ctrl-R in the app) to apply this to the index.")
      return 0
    }
    case "reset":
      saveConfig(defaultConfig())
      console.log("Configuration reset to defaults.")
      return 0
    default:
      throw new UsageError(`unknown config action "${action}" (show, get, set, path, reset)`)
  }
}

/* ------------------------------------------------------------------ reset -- */

function cmdReset(): number {
  const p = paths()
  const holder = lockHolder(p.lock)
  if (holder) {
    console.error(`zsearch: indexing is in progress (pid ${holder}); stop it first`)
    return 1
  }
  for (const path of [p.db, semanticDbPath(p.db)]) for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true })
  console.log(`Deleted the index at ${tildify(p.db)}.`)
  return 0
}

/* --------------------------------------------------------------- semantic -- */

async function cmdSemantic(rest: string[], args: Args): Promise<number> {
  const p = paths()
  const action = rest[0] ?? "status"
  const config = loadConfig()
  switch (action) {
    case "status": {
      const s = semanticStatus(config, p.db)
      if (flag(args, "json")) {
        console.log(JSON.stringify(s, null, 2))
        return 0
      }
      console.log(`Semantic search  ${s.enabled ? "on" : "off"}${s.blocked && s.enabled ? ` (not running: ${s.blocked})` : ""}`)
      console.log(`Model              ${tildify(s.modelDir)}: ${GRANITE.name} ${s.model.ready ? "ok" : "not downloaded"}`)
      console.log(`Helper             ${s.helper ? tildify(s.helper) : "not found (scripts/build-embed.sh builds it; the Mac app has it); Granite cannot run"}`)
      const line = (i: NonNullable<typeof s.index>) => `${formatCount(i.files)} files, ${formatCount(i.passages)} passages, ${formatCount(i.vectors)} vectors, ${formatBytes(i.bytes)}${i.lastRunAt ? `, updated ${formatAge(i.lastRunAt)}` : ""}${i.error ? `; last error: ${i.error}` : ""}`
      if (s.index) console.log(`Granite index      ${line(s.index)}`)
      return 0
    }
    case "install": {
      console.error(`Downloading ${GRANITE.name} (${GRANITE.repository}, ${GRANITE.license}), ${formatBytes(modelBytes())}…`)
      const tty = process.stderr.isTTY === true
      const controller = new AbortController()
      const onSignal = () => controller.abort()
      process.on("SIGINT", onSignal)
      try {
        await downloadModels({
          signal: controller.signal,
          onProgress: (d) => { if (tty) process.stderr.write(`\r\x1b[2K${d.file} ${Math.floor((d.received / d.total) * 100)}% of ${formatBytes(d.total)}`) },
        })
      } finally {
        process.off("SIGINT", onSignal)
        if (tty) process.stderr.write("\r\x1b[2K")
      }
      // Read again: settings may have changed during the download.
      const latest = loadConfig()
      saveConfig({ ...latest, defaultMode: "semantic", semantic: { ...latest.semantic, enabled: true, declined: false } })
      console.error("Semantic search is on: the next index update reads your files for it (`zsearch index` starts one now).")
      if (!embedToolPath()) console.error("Granite needs the embedding helper: build it with scripts/build-embed.sh for Granite, or use the Mac app.")
      return 0
    }
    case "remove":
    case "off": {
      const holder = lockHolder(p.lock)
      if (holder) {
        console.error(`zsearch: indexing is in progress (pid ${holder}); stop it first`)
        return 1
      }
      saveConfig({ ...config, defaultMode: "find", semantic: { ...config.semantic, enabled: false, declined: true } })
      removeSemantic(p.db)
      console.error("Semantic search is off; its model and index are deleted.")
      return 0
    }
    default:
      throw new UsageError(`unknown semantic action "${action}" (status, install, remove)`)
  }
}

/* ----------------------------------------------------------------- doctor -- */

function cmdDoctor(): number {
  const p = paths()
  const ok = (b: boolean) => (b ? "ok " : "-- ")
  const sqlite = (new Database(":memory:").query("SELECT sqlite_version() AS v").get() as { v: string }).v
  let fts5 = false
  try {
    const d = new Database(":memory:")
    d.exec("CREATE VIRTUAL TABLE t USING fts5(x)")
    fts5 = true
  } catch {
    fts5 = false
  }
  console.log(`zsearch ${VERSION} on ${process.platform}/${process.arch}, Bun ${Bun.version}`)
  console.log(`${ok(fts5)} SQLite ${sqlite} with FTS5${fts5 ? "" : " — missing! full-text search will not work"}`)
  const pdf = pdftotextPath()
  console.log(`${ok(!!pdf)} pdftotext ${pdf ?? "not found — using the built-in PDF reader (slower); install poppler for speed"}`)
  const ocr = ocrToolPath()
  console.log(`${ok(!!ocr)} OCR ${ocr ?? "not available — images and scanned PDF pages are indexed by name only (the Mac app has it)"}`)
  const sem = semanticStatus(loadConfig(), p.db)
  console.log(`${ok(!!sem.helper)} embedding helper ${sem.helper ?? "not found — semantic search needs zsearch-embed (in the Mac app; scripts/build-embed.sh builds it)"}`)
  console.log(`${ok(sem.model.ready)} semantic model ${sem.model.ready ? tildify(sem.modelDir) : "not downloaded (zsearch semantic install)"}`)
  console.log(`${ok(existsSync(p.db))} index ${tildify(p.db)}`)
  console.log(`${ok(configExists())} config ${tildify(p.configFile)}`)
  return 0
}

export type { Config }

function commandHelp(command?: string): string {
  const usage: Record<string, string> = { semantic: "semantic [status [--json]|install|remove]", search: "search <query> [-m find|fuzzy|semantic] [-e] [-n N] [-l|-0|--csv|--json] [--sort name|size|date|path]", index: "index [folders...] [--docs|--home|--disk] [--hidden] [--no-content] [--rebuild] [-q]", status: "status [--errors] [--json]", estimate: "estimate [folders...] [--docs|--home|--disk] [--json]", config: "config [show|get <key>|set <key> <value>|path|reset]", reset: "reset", doctor: "doctor", serve: "serve (JSON lines on stdin/stdout)", mcp: "mcp (MCP JSON-RPC on stdin/stdout)", duplicates: "duplicates [--json]", exclude: "exclude <indexed file or folder>" }
  return command && usage[command] ? `zsearch ${usage[command]}\n` : HELP
}
