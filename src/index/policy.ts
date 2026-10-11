import ignore from "ignore"
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { type Config, resolvePath } from "../config.ts"
import { cloudFolders, onlyChildren, SKIP_DIR_NAMES, systemExcludes, systemNamesOnly } from "../platform.ts"
import type { CrawlOptions } from "./crawler.ts"

export function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")
}

function canonical(path: string): string {
  if (!existsSync(path)) return path
  try { return realpathSync(path) } catch { return path }
}

// Parsed rules may be reused, but their inode/size/timestamps are checked on each
// new stage or extraction. Neither missing files nor policy decisions persist.
const ignoreFiles = new Map<string, { stamp: string; bytes: number; rules: ReturnType<typeof ignore> }>()
let ignoreBytes = 0
function forgetIgnore(file: string) {
  const previous = ignoreFiles.get(file)
  if (previous) { ignoreBytes -= previous.bytes; ignoreFiles.delete(file) }
}
function readIgnore(file: string) {
  if (!existsSync(file)) { forgetIgnore(file); return null }
  const st = lstatSync(file)
  if (!st.isFile() || st.size > 1024 * 1024) { forgetIgnore(file); return null }
  const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
  const previous = ignoreFiles.get(file)
  if (previous?.stamp === stamp) {
    ignoreFiles.delete(file); ignoreFiles.set(file, previous)
    return previous.rules
  }
  forgetIgnore(file)
  const rules = ignore({ allowRelativePaths: true }).add(readFileSync(file, "utf8"))
  while (ignoreFiles.size >= 128 || ignoreBytes + st.size > 4 * 1024 * 1024) forgetIgnore(ignoreFiles.keys().next().value!)
  ignoreFiles.set(file, { stamp, bytes: st.size, rules }); ignoreBytes += st.size
  return rules
}

export function crawlOptionsFor(config: Config): CrawlOptions {
  const roots = [...new Set(config.roots.map(resolvePath))]
  const realRoots = roots.map(canonical)
  const userAbs = config.exclude.filter((p) => p.startsWith("/") || p.startsWith("~")).map(resolvePath)
  return {
    roots, includeHidden: config.includeHidden, respectGitignore: config.respectGitignore,
    followSymlinks: config.followSymlinks, oneFileSystem: config.oneFileSystem,
    excludePatterns: config.exclude.filter((p) => !(p.startsWith("/") || p.startsWith("~"))),
    // User exclusions always win, even when they equal a configured root.
    excludePaths: [...systemExcludes().filter((e) => !roots.some((r) => under(r, e)) && !realRoots.some((r) => under(r, canonical(e)))), ...userAbs],
    onlyChildren: onlyChildren(),
    namesOnly: [...config.namesOnly.map(resolvePath), ...(roots.includes("/") ? systemNamesOnly() : []), ...(config.cloudContent ? [] : cloudFolders())],
  }
}

/** Recheck the alias and real target using the same privacy rules at every file read. */
export function pathPolicy(path: string, opts: CrawlOptions): { allowed: boolean; content: boolean; reason?: string; real?: string } {
  return policyFor(opts)(path)
}

/** A short-lived checker for one synchronous search stage; never reuse across requests. */
export function policyFor(opts: CrawlOptions) {
  const deny = (reason: string) => ({ allowed: false, content: false, reason })
  const roots = [...opts.roots].sort((a, b) => a.length - b.length)
  const canonicalRoots = new Map(roots.map((r) => [r, canonical(r)]))
  const realRoots = [...canonicalRoots.values()].sort((a, b) => a.length - b.length)
  const excludes = [...new Set(opts.excludePaths.flatMap((e) => [e, canonical(e)]))]
  const namesOnly = [...new Set(opts.namesOnly.flatMap((p) => [p, canonical(p)]))]
  const userIgnore = opts.excludePatterns.length ? ignore({ allowRelativePaths: true }).add(opts.excludePatterns) : null
  const directoryIgnores = new Map<string, ReturnType<typeof ignore>[]>()
  const realDirectories = new Map<string, string>()
  const ignoresAt = (dir: string) => {
    let rules = directoryIgnores.get(dir)
    if (rules) return rules
    rules = []
    for (const f of opts.respectGitignore ? [".gitignore", ".ignore", ".zsearchignore"] : [".zsearchignore"]) {
      try {
        const file = join(dir, f)
        // Ignore files cannot be used as an out-of-root read gadget themselves.
        const rule = readIgnore(file)
        if (rule) rules.push(rule)
      } catch {}
    }
    directoryIgnores.set(dir, rules)
    return rules
  }
  const passes = (p: string, r: string, isDir: boolean): boolean => {
    if (excludes.some((e) => under(p, e))) return false
    const parts = relative(r, p).split("/").filter(Boolean)
    if (!opts.includeHidden && parts.some((s) => s.startsWith("."))) return false
    if (parts.slice(0, -1).some((s) => (opts.skipDirNames ?? SKIP_DIR_NAMES).has(s))) return false
    const rel = relative(r, p)
    if (rel && userIgnore?.ignores(rel + (isDir ? "/" : ""))) return false
    let dir = r
    const levels: { base: string; ig: ReturnType<typeof ignore> }[] = []
    for (let i = 0; i < parts.length; i++) {
      for (const ig of ignoresAt(dir)) levels.push({ base: dir, ig })
      dir = join(dir, parts[i]!)
      const only = opts.onlyChildren.get(join(r, ...parts.slice(0, i)))
      if (only && !only.has(parts[i]!)) return false
      let ignored = false
      for (const { base, ig } of levels) {
        const t = ig.test(relative(base, dir) + (i < parts.length - 1 || isDir ? "/" : ""))
        if (t.ignored) ignored = true
        else if (t.unignored) ignored = false
      }
      if (ignored) return false
    }
    return true
  }
  const evaluate = (path: string): { allowed: boolean; content: boolean; reason?: string; real?: string } => {
    const root = roots.find((r) => under(path, r))
    if (!root) return deny("outside indexed folders")
    let real: string
    let st
    try {
      st = lstatSync(path)
      if (st.isSymbolicLink()) { real = realpathSync(path); st = statSync(real) }
      else {
        const parent = dirname(path)
        let realParent = realDirectories.get(parent)
        if (!realParent) { realParent = realpathSync(parent); realDirectories.set(parent, realParent) }
        real = join(realParent, basename(path))
      }
    } catch { return deny("file unavailable") }
    const targetRoot = realRoots.find((r) => under(real, r))
    if (!targetRoot) return deny("symbolic link target is outside indexed folders")
    if (!opts.followSymlinks && real !== join(canonicalRoots.get(root)!, relative(root, path))) return deny("symbolic links are disabled")
    if (!passes(path, root, st.isDirectory()) || (real !== path && !passes(real, targetRoot, st.isDirectory()))) return deny("file is excluded by current settings")
    const offline = st.size > 4096 && st.blocks === 0
    const content = !offline && !credentialPath(path) && !credentialPath(real) && !namesOnly.some((p) => under(path, p) || under(real, p))
    return { allowed: true, content, real, ...(!content ? { reason: "contents are disabled for this folder" } : {}) }
  }
  const decisions = new Map<string, ReturnType<typeof evaluate>>()
  return (path: string) => {
    let decision = decisions.get(path)
    if (!decision) { decision = evaluate(path); decisions.set(path, decision) }
    return decision
  }
}

/** MCP never returns common private keys and authentication stores. */
export function credentialPath(path: string): boolean {
  return /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.kube)(?:\/|$)|(?:^|\/)(?:\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials\.json|id_(?:rsa|dsa|ecdsa|ed25519))(?:$|\.)/i.test(path)
}
