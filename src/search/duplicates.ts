import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs"
import type { Config } from "../config.ts"
import { crawlOptionsFor, policyFor } from "../index/policy.ts"

/** Same size first, then streaming SHA-256; changed files are never reported as duplicates. */
export async function duplicateFiles(db: Database, config: Config, budgetMs = 30_000): Promise<{ groups: { size: number; hash: string; paths: string[] }[]; partial: boolean }> {
  const rows = db.query("SELECT path, size FROM files WHERE is_dir = 0 AND size > 0 AND size IN (SELECT size FROM files WHERE is_dir = 0 GROUP BY size HAVING COUNT(*) > 1) ORDER BY size").all() as { path: string; size: number }[]
  const groups = new Map<string, { size: number; hash: string; paths: string[] }>()
  if (!config.content.enabled) return { groups: [], partial: false }
  const opts = crawlOptionsFor(config), deadline = performance.now() + budgetMs
  let partial = false
  const bytes = new Uint8Array(256 * 1024)
  // Policy checkers are for synchronous stretches only: start a fresh one after each await.
  let check = policyFor(opts)
  for (const row of rows) {
    if (performance.now() > deadline) { partial = true; break }
    const policy = check(row.path)
    if (!policy.allowed || !policy.content) continue
    check = policyFor(opts)
    let fd: number | undefined
    try {
      fd = openSync(policy.real!, constants.O_RDONLY | constants.O_NOFOLLOW)
      const before = fstatSync(fd)
      if (!before.isFile() || before.size !== row.size) continue
      const hash = createHash("sha256")
      let position = 0
      while (position < before.size) {
        const n = readSync(fd, bytes, 0, Math.min(bytes.length, before.size - position), position)
        if (!n || performance.now() > deadline) break
        hash.update(bytes.subarray(0, n)); position += n
        await new Promise((r) => setImmediate(r))
      }
      const after = fstatSync(fd)
      if (position !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) { partial ||= performance.now() > deadline; continue }
      const digest = hash.digest("hex"), key = `${before.size}:${digest}`
      const group = groups.get(key) ?? { size: before.size, hash: digest, paths: [] }
      group.paths.push(row.path); groups.set(key, group)
    } catch {} finally { if (fd !== undefined) closeSync(fd) }
  }
  return { groups: [...groups.values()].filter((g) => g.paths.length > 1), partial }
}
