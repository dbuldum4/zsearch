import type { Database } from "bun:sqlite"
import { type Config, resolvePath } from "../config.ts"

/** A narrowing operation: only a known indexed path can be excluded. */
export function excludingPath(db: Database, config: Config, input: string): Config {
  const path = resolvePath(input)
  const row = db.query("SELECT path FROM files WHERE path = ?").get(path) as { path: string } | null
  if (!row && !config.roots.map(resolvePath).includes(path) && !config.exclude.includes(path)) throw new Error("path is not indexed")
  return { ...config, exclude: [...new Set([...config.exclude, row?.path ?? path])] }
}
