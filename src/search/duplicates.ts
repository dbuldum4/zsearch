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
  // Policy checkers are for synchronous stretches only: start a fresh one after each await.
  let check = policyFor(opts)
  for (const row of rows) {
    if (performance.now() > deadline) { partial = true; break }
    const policy = check(row.path)
    if (!policy.allowed || !policy.content) continue
    const digest = fileDigest(policy.real!, { size: row.size }, deadline)
    await new Promise((r) => setImmediate(r))
    check = policyFor(opts)
    if (!digest) { partial ||= performance.now() > deadline; continue }
    const key = `${row.size}:${digest}`
    const group = groups.get(key) ?? { size: row.size, hash: digest, paths: [] }
    group.paths.push(row.path); groups.set(key, group)
  }
  return { groups: [...groups.values()].filter((g) => g.paths.length > 1), partial }
}

const buffer = new Uint8Array(256 * 1024)

/**
 * SHA-256 (hex) of the regular file at `path`, opened without following a final symlink. Null
 * if it is not one, has not `expected.size` bytes (or, when given, its times), changed while it
 * was read, or `deadline` passed first.
 */
export function fileDigest(path: string, expected: { size: number; mtimeMs?: number; ctimeMs?: number }, deadline = Infinity): string | null {
  let fd: number | undefined
  try {
    // O_NONBLOCK: a FIFO in place of the file would otherwise block the open until a writer comes.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(fd)
    if (!before.isFile() || before.size !== expected.size) return null
    if (expected.mtimeMs !== undefined && (before.mtimeMs !== expected.mtimeMs || before.ctimeMs !== expected.ctimeMs)) return null
    const hash = createHash("sha256")
    let position = 0
    while (position < before.size) {
      if (performance.now() > deadline) return null
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position)
      if (!n) return null
      hash.update(buffer.subarray(0, n)); position += n
    }
    const after = fstatSync(fd)
    if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) return null
    return hash.digest("hex")
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
