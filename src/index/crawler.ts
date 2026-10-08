import ignore, { type Ignore } from "ignore"
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { extOf } from "../kinds.ts"
import { isMac, PACKAGE_EXTS, SKIP_DIR_NAMES } from "../platform.ts"

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
  /** Skip folders with these names anywhere (defaults to SKIP_DIR_NAMES). */
  skipDirNames?: Set<string>
  /** Treat macOS bundle folders (.app, .photoslibrary...) as opaque files. */
  opaquePackages?: boolean
}

export interface CrawlEntry {
  path: string
  name: string
  isDir: boolean
  size: number
  mtime: number
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
}

const IGNORE_FILES = [".gitignore", ".ignore", ".zsearchignore"]

interface IgnoreLevel {
  base: string
  ig: Ignore
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")
}

/**
 * Walk the configured roots depth-first, yielding files and folders.
 * Synchronous on purpose: it runs inside the indexer worker, where blocking is fine and
 * avoiding promise overhead per entry makes the scan several times faster.
 */
export function* crawl(opts: CrawlOptions, stats: CrawlStats = { dirs: 0, files: 0, errors: 0, skipped: 0 }): Generator<CrawlEntry> {
  const skipNames = opts.skipDirNames ?? SKIP_DIR_NAMES
  const excludePaths = opts.excludePaths.filter(Boolean)
  const userIgnore = opts.excludePatterns.length ? ignore({ allowRelativePaths: true }).add(opts.excludePatterns) : null
  const opaque = opts.opaquePackages ?? isMac
  const visitedReal = new Set<string>()
  const seenRoots = new Set<string>()

  for (const root of opts.roots) {
    if (seenRoots.has(root) || [...seenRoots].some((r) => under(root, r))) continue
    seenRoots.add(root)
    let rootStat
    try {
      rootStat = statSync(root)
    } catch {
      stats.errors++
      continue
    }
    if (!rootStat.isDirectory()) {
      const name = root.split("/").pop() || root
      stats.files++
      yield { path: root, name, isDir: false, size: rootStat.size, mtime: Math.floor(rootStat.mtimeMs), namesOnly: false }
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
    // Explicit stack: [dir, ignore levels, namesOnly, depth]
    const stack: [string, IgnoreLevel[], boolean, number][] = [[root, [], opts.namesOnly.some((p) => under(root, p)), 0]]
    while (stack.length) {
      const [dir, parentLevels, dirNamesOnly, depth] = stack.pop()!
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        stats.errors++
        continue
      }
      stats.dirs++
      let levels = parentLevels
      if (opts.respectGitignore) {
        for (const f of IGNORE_FILES) {
          if (!entries.some((e) => e.name === f && !e.isDirectory())) continue
          try {
            const ig = ignore({ allowRelativePaths: true }).add(readFileSync(join(dir, f), "utf8"))
            if (levels === parentLevels) levels = [...parentLevels]
            levels.push({ base: dir, ig })
          } catch {
            // unreadable ignore file
          }
        }
      }
      const only = opts.onlyChildren.get(dir)
      const subdirs: [string, IgnoreLevel[], boolean, number][] = []
      for (const ent of entries) {
        const name = ent.name
        const path = dir === "/" ? `/${name}` : `${dir}/${name}`
        if (only && !only.has(name)) continue
        if (!opts.includeHidden && name.charCodeAt(0) === 46 /* . */) {
          stats.skipped++
          continue
        }
        let isDir = ent.isDirectory()
        let isLink = ent.isSymbolicLink()
        if (isDir && skipNames.has(name)) {
          stats.skipped++
          continue
        }
        if (excludePaths.some((p) => under(path, p))) {
          stats.skipped++
          continue
        }
        if (userIgnore && userIgnore.ignores(relative(root, path) + (isDir ? "/" : ""))) {
          stats.skipped++
          continue
        }
        if (levels.length && isIgnored(levels, path, isDir)) {
          stats.skipped++
          continue
        }
        let st
        try {
          st = lstatSync(path)
          if (isLink || st.isSymbolicLink()) {
            isLink = true
            st = statSync(path)
            isDir = st.isDirectory()
            if (isDir && !opts.followSymlinks) {
              stats.skipped++
              continue
            }
          } else if (!ent.isFile() && !isDir) {
            // sockets, fifos, devices
            if (!st.isFile() && !st.isDirectory()) continue
            isDir = st.isDirectory()
          }
        } catch {
          stats.errors++
          continue
        }
        const namesOnly = dirNamesOnly || (opts.namesOnly.length > 0 && opts.namesOnly.some((p) => under(path, p)))
        if (isDir) {
          yield { path, name, isDir: true, size: 0, mtime: Math.floor(st.mtimeMs), namesOnly }
          if (opaque && PACKAGE_EXTS.has(extOf(name))) continue
          if (opts.oneFileSystem && st.dev !== rootDev) continue
          if (depth >= 64) continue
          if (isLink) {
            try {
              const real = realpathSync(path)
              if (visitedReal.has(real)) continue
              visitedReal.add(real)
            } catch {
              continue
            }
          }
          subdirs.push([path, levels, namesOnly, depth + 1])
        } else {
          stats.files++
          const offline = st.size > 4096 && st.blocks === 0
          yield { path, name, isDir: false, size: st.size, mtime: Math.floor(st.mtimeMs), namesOnly, offline }
        }
      }
      // Reverse so the walk visits folders in directory order.
      for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]!)
    }
  }
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
