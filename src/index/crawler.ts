import ignore, { type Ignore } from "ignore"
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { extOf } from "../kinds.ts"
import { isMac, PACKAGE_EXTS, SKIP_DIR_NAMES } from "../platform.ts"
import { pathPolicy, under } from "./policy.ts"

export interface CrawlOptions {
  roots: string[]
  includeHidden: boolean
  respectGitignore: boolean
  followSymlinks: boolean
  oneFileSystem: boolean
  /** gitignore-style patterns applied relative to each root. */
  excludePatterns: string[]
  /** Absolute folders (and everything below) to skip. */
  excludePaths: string[]
  /** Folders where only the listed child names are walked. */
  onlyChildren: Map<string, Set<string>>
  /** Absolute folders whose files are indexed by name only. */
  namesOnly: string[]
  /** Hide stored speech transcripts as soon as the user opts out. */
  transcribe?: boolean
  /** Skip folders with these names anywhere (defaults to SKIP_DIR_NAMES). */
  skipDirNames?: Set<string>
  /** Treat macOS bundle folders (.app, .photoslibrary...) as opaque files. */
  opaquePackages?: boolean
}

interface CrawlEntry {
  path: string
  name: string
  isDir: boolean
  size: number
  mtime: number
  created?: number
  dev?: number
  ino?: number
  namesOnly: boolean
  /**
   * The file's data is not stored locally (cloud "online-only" placeholder, sparse file):
   * reading it would trigger a download, so only its name is indexed.
   */
  offline?: boolean
}

export interface CrawlStats {
  dirs: number
  files: number
  errors: number
  skipped: number
  unreadable?: string[]
}

const IGNORE_FILES = [".gitignore", ".ignore", ".zsearchignore"]

interface IgnoreLevel {
  base: string
  ig: Ignore
}

/** A folder to list: its path, the ignore rules above it, whether it is names-only, and its depth. */
type Walk = [string, IgnoreLevel[], boolean, number]

/**
 * Walk the configured roots depth-first, yielding files and folders.
 * Synchronous on purpose: it runs inside the indexer worker, where blocking is fine and
 * avoiding promise overhead per entry makes the scan several times faster.
 *
 * With `targets` (from `crawlTargets`), only those paths are walked. Each is reached from its
 * root under the same rules as in a full walk, and folders among them are walked whole. The
 * folders on the way are yielded as well: their modification times change with what is in them.
 */
export function* crawl(opts: CrawlOptions, stats: CrawlStats = { dirs: 0, files: 0, errors: 0, skipped: 0 }, targets?: string[]): Generator<CrawlEntry> {
  const skipNames = opts.skipDirNames ?? SKIP_DIR_NAMES
  const excludePaths = opts.excludePaths.filter(Boolean)
  const failed = (path: string) => {
    stats.errors++
    // Some platforms report both a directory failure and failures below it.
    // Store each unavailable subtree once for cleanup and permission status.
    const unreadable = stats.unreadable ?? []
    if (!unreadable.some((p) => under(path, p))) {
      stats.unreadable = [...unreadable.filter((p) => !under(p, path)), path]
    }
  }
  const userIgnore = opts.excludePatterns.length ? ignore({ allowRelativePaths: true }).add(opts.excludePatterns) : null
  const opaque = opts.opaquePackages ?? isMac
  const visitedReal = new Set<string>()
  const seenRoots = new Set<string>()

  const namesOnlyPrefixes = opts.namesOnly.map((path) => ({ path, child: path === "/" ? "/" : path + "/" }))
  const excludePrefixes = excludePaths.map((path) => ({ path, child: path === "/" ? "/" : path + "/" }))
  const prefixed = (path: string, prefixes: { path: string; child: string }[]) => prefixes.some((p) => path === p.path || path.startsWith(p.child))

  /** The ignore rules that apply in `dir`: those above it, and those of its own ignore files. */
  const levelsAt = (dir: string, parentLevels: IgnoreLevel[], has: (name: string) => boolean): IgnoreLevel[] => {
    let levels = parentLevels
    for (const f of IGNORE_FILES) {
      if (f !== ".zsearchignore" && !opts.respectGitignore) continue
      if (!has(f)) continue
      try {
        const file = join(dir, f)
        if (lstatSync(file).isSymbolicLink() || statSync(file).size > 1024 * 1024) continue
        const ig = ignore({ allowRelativePaths: true }).add(readFileSync(file, "utf8"))
        if (levels === parentLevels) levels = [...parentLevels]
        levels.push({ base: dir, ig })
      } catch {
        // unreadable ignore file
      }
    }
    return levels
  }

  /** What the walk makes of the entry `name` of a folder: null when it leaves it out, with `next` when it goes into it. */
  const visit = (root: string, rootDev: number, [dir, levels, dirNamesOnly, depth]: Walk, name: string, ent: Pick<Dirent, "isDirectory" | "isFile" | "isSymbolicLink">): { entry: CrawlEntry; next?: Walk } | null => {
    const path = dir === "/" ? `/${name}` : `${dir}/${name}`
    const only = opts.onlyChildren.get(dir)
    if (only && !only.has(name)) return null
    if (!opts.includeHidden && name.charCodeAt(0) === 46 /* . */) {
      stats.skipped++
      return null
    }
    let isDir = ent.isDirectory()
    let isLink = ent.isSymbolicLink()
    if (isDir && skipNames.has(name)) {
      stats.skipped++
      return null
    }
    if (prefixed(path, excludePrefixes)) {
      stats.skipped++
      return null
    }
    if (userIgnore && userIgnore.ignores(relative(root, path) + (isDir ? "/" : ""))) {
      stats.skipped++
      return null
    }
    if (levels.length && isIgnored(levels, path, isDir)) {
      stats.skipped++
      return null
    }
    let st
    try {
      st = lstatSync(path)
      if (isLink || st.isSymbolicLink()) {
        isLink = true
        if (!opts.followSymlinks || !pathPolicy(path, opts).allowed) { stats.skipped++; return null }
        st = statSync(path)
        isDir = st.isDirectory()
        if (isDir && !opts.followSymlinks) {
          stats.skipped++
          return null
        }
      } else if (!ent.isFile() && !isDir) {
        // sockets, fifos, devices
        if (!st.isFile() && !st.isDirectory()) return null
        isDir = st.isDirectory()
      }
    } catch {
      failed(path)
      return null
    }
    const namesOnly = dirNamesOnly || (isLink ? !pathPolicy(path, opts).content : prefixed(path, namesOnlyPrefixes))
    if (isDir) {
      const entry = { path, name, isDir: true, size: 0, mtime: Math.floor(st.mtimeMs), created: Math.floor(st.birthtimeMs), dev: st.dev, ino: st.ino, namesOnly }
      if (opaque && PACKAGE_EXTS.has(extOf(name))) return { entry }
      if (opts.oneFileSystem && st.dev !== rootDev) return { entry }
      if (depth >= 64) return { entry }
      if (isLink) {
        try {
          const real = realpathSync(path)
          if (visitedReal.has(real)) return { entry }
          visitedReal.add(real)
        } catch {
          return { entry }
        }
      }
      return { entry, next: [path, levels, namesOnly, depth + 1] }
    }
    stats.files++
    const offline = st.size > 4096 && st.blocks === 0
    return { entry: { path, name, isDir: false, size: st.size, mtime: Math.floor(st.mtimeMs), created: Math.floor(st.birthtimeMs), dev: st.dev, ino: st.ino, namesOnly, offline } }
  }

  /** Folders yielded on the way to a target: several targets often share them. */
  const passed = new Set<string>()
  const targetLevels = new Map<string, IgnoreLevel[]>()
  const isFileAt = (path: string) => {
    try { return !lstatSync(path).isDirectory() } catch { return false }
  }

  for (const root of [...opts.roots].sort((a, b) => a.length - b.length)) {
    if (prefixed(root, excludePrefixes)) continue
    if (seenRoots.has(root) || [...seenRoots].some((r) => under(root, r))) continue
    seenRoots.add(root)
    if (targets && !targets.some((t) => under(t, root))) continue
    let rootStat
    try {
      rootStat = statSync(root)
    } catch {
      failed(root)
      continue
    }
    if (!rootStat.isDirectory()) {
      const name = root.split("/").pop() || root
      stats.files++
      const policy = pathPolicy(root, opts)
      if (policy.allowed) yield { path: root, name, isDir: false, size: rootStat.size, mtime: Math.floor(rootStat.mtimeMs), created: Math.floor(rootStat.birthtimeMs), dev: rootStat.dev, ino: rootStat.ino, namesOnly: !policy.content }
      continue
    }
    const rootDev = rootStat.dev
    if (opts.followSymlinks) {
      try {
        visitedReal.add(realpathSync(root))
      } catch {
        // ignore
      }
    }
    const start: Walk = [root, [], prefixed(root, namesOnlyPrefixes), 0]
    const stack: Walk[] = targets ? [] : [start]
    for (const target of targets ?? []) {
      if (!under(target, root)) continue
      if (target === root) {
        stack.push(start)
        continue
      }
      // Go down to the target one name at a time, checking each like the full walk would.
      const parts = relative(root, target).split("/")
      let at = start
      for (let i = 0; i < parts.length; i++) {
        const [dir, parentLevels, dirNamesOnly, depth] = at
        let levels = targetLevels.get(dir)
        if (!levels) {
          levels = levelsAt(dir, parentLevels, (f) => isFileAt(join(dir, f)))
          targetLevels.set(dir, levels)
        }
        const path = join(dir, parts[i]!)
        let st
        try {
          st = lstatSync(path)
        } catch (err) {
          // Gone: the index drops what it had there. Otherwise it is unreadable, and kept.
          const code = (err as NodeJS.ErrnoException).code
          if (code !== "ENOENT" && code !== "ENOTDIR") failed(path)
          break
        }
        const seen = visit(root, rootDev, [dir, levels, dirNamesOnly, depth], parts[i]!, st)
        if (!seen) break
        const last = i === parts.length - 1
        if (last || !passed.has(path)) {
          passed.add(path)
          yield seen.entry
        }
        if (!seen.next) break
        if (last) stack.push(seen.next)
        else at = seen.next
      }
    }
    while (stack.length) {
      const [dir, parentLevels, dirNamesOnly, depth] = stack.pop()!
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        failed(dir)
        continue
      }
      stats.dirs++
      const levels = levelsAt(dir, parentLevels, (f) => entries.some((e) => e.name === f && !e.isDirectory()))
      const at: Walk = [dir, levels, dirNamesOnly, depth]
      const subdirs: Walk[] = []
      for (const ent of entries) {
        const seen = visit(root, rootDev, at, ent.name, ent)
        if (!seen) continue
        yield seen.entry
        if (seen.next) subdirs.push(seen.next)
      }
      // Reverse so the walk visits folders in directory order.
      for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]!)
    }
  }
}

/**
 * The paths a walk of changed paths covers (see `crawl`). Paths outside the roots are left out.
 * An ignore file stands for its folder, where its rules change what is indexed; a path inside a
 * package for the package, which the walk does not go into; a path whose folders are gone for
 * the highest folder gone. Paths inside another of them are left out too.
 */
export function crawlTargets(opts: CrawlOptions, changed: string[]): string[] {
  const roots = [...opts.roots].sort((a, b) => a.length - b.length)
  const opaque = opts.opaquePackages ?? isMac
  const present = (path: string) => {
    try { lstatSync(path); return true } catch { return false }
  }
  const found = new Set<string>()
  for (const changedPath of changed) {
    if (!changedPath.startsWith("/")) continue
    let path = changedPath.length > 1 ? changedPath.replace(/\/+$/, "") : changedPath
    const root = roots.find((r) => under(path, r))
    if (!root) continue
    if (path !== root && IGNORE_FILES.includes(basename(path))) path = dirname(path)
    if (opaque && path !== root) {
      const parts = relative(root, path).split("/")
      const i = parts.findIndex((p, k) => k < parts.length - 1 && PACKAGE_EXTS.has(extOf(p)))
      if (i >= 0) path = join(root, ...parts.slice(0, i + 1))
    }
    while (path !== root && dirname(path) !== root && !present(dirname(path))) path = dirname(path)
    found.add(path)
  }
  return [...found].filter((path) => {
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      if (found.has(dir)) return false
      if (dir === dirname(dir)) return true
    }
  })
}

function isIgnored(levels: IgnoreLevel[], path: string, isDir: boolean): boolean {
  let ignored = false
  for (const { base, ig } of levels) {
    const rel = relative(base, path)
    if (!rel || rel.startsWith("..")) continue
    const r = ig.test(isDir ? rel + "/" : rel)
    if (r.ignored) ignored = true
    else if (r.unignored) ignored = false
  }
  return ignored
}
