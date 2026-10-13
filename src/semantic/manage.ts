/** Turning search by meaning on and off, and what to say about it (CLI, app, MCP). */
import { rmSync } from "node:fs"
import type { Config } from "../config.ts"
import { embedToolPath } from "./helper.ts"
import { semanticAvailable } from "./indexer.ts"
import { GRANITE, installedModel, modelBytes, modelsRoot, POTION, removeModels } from "./model.ts"
import { openSemanticDb, semanticDbPath, type SemanticStats, semanticStats } from "./store.ts"
import type { Tier } from "./model.ts"

export interface SemanticStatus {
  enabled: boolean
  /** Someone turned it off: the app doesn't download the models when it starts. */
  declined: boolean
  code: boolean
  /** The embedding helper (Granite's), if there is one. */
  helper: string | null
  modelDir: string
  /** Which models are downloaded: Potion ("fast") and Granite ("full"). */
  model: { fast: boolean; full: boolean; fastBytes: number; fullBytes: number }
  /** Why indexing for meaning doesn't run, or null when it does. */
  blocked: string | null
  /** Granite's index, and Potion's. */
  index: SemanticStats | null
  fastIndex: SemanticStats | null
}

function stats(dbPath: string, tier: Tier): SemanticStats | null {
  const path = semanticDbPath(dbPath, tier)
  try {
    const db = openSemanticDb(path, { readonly: true })
    if (db) {
      try { return semanticStats(db, path) } finally { db.close() }
    }
  } catch {}
  return null
}

export function semanticStatus(config: Config, dbPath: string): SemanticStatus {
  const tool = embedToolPath()
  return {
    enabled: config.semantic.enabled,
    declined: config.semantic.declined,
    code: config.semantic.code,
    helper: tool,
    modelDir: modelsRoot(),
    model: { fast: installedModel(POTION) !== null, full: installedModel(GRANITE) !== null, fastBytes: modelBytes(POTION), fullBytes: modelBytes(GRANITE) },
    blocked: semanticAvailable(config, tool),
    index: stats(dbPath, "full"),
    fastIndex: stats(dbPath, "fast"),
  }
}

/** Delete the models and the semantic indexes (the setting is the caller's to turn off). */
export function removeSemantic(dbPath: string): void {
  removeModels()
  for (const tier of ["fast", "full"] as const) {
    const path = semanticDbPath(dbPath, tier)
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true })
  }
}
