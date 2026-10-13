/** Turning semantic search on and off, and what to say about it (CLI, app, MCP). */
import { rmSync } from "node:fs"
import type { Config } from "../config.ts"
import { embedToolPath } from "./helper.ts"
import { semanticAvailable } from "./indexer.ts"
import { GRANITE, installedModel, modelBytes, modelsRoot, removeModels } from "./model.ts"
import { openSemanticDb, semanticDbPath, type SemanticStats, semanticStats } from "./store.ts"

export interface SemanticStatus {
  enabled: boolean
  /** Someone turned it off: the app doesn't download the model when it starts. */
  declined: boolean
  code: boolean
  /** The embedding helper (Granite's), if there is one. */
  helper: string | null
  modelDir: string
  /** Whether Granite is downloaded and its download size. */
  model: { ready: boolean; bytes: number }
  /** Why indexing for meaning doesn't run, or null when it does. */
  blocked: string | null
  /** Granite's index. */
  index: SemanticStats | null
}

function stats(dbPath: string): SemanticStats | null {
  const path = semanticDbPath(dbPath)
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
    model: { ready: installedModel(GRANITE) !== null, bytes: modelBytes(GRANITE) },
    blocked: semanticAvailable(config, tool),
    index: stats(dbPath),
  }
}

/** Delete the model and the semantic index (the setting is the caller's to turn off). */
export function removeSemantic(dbPath: string): void {
  removeModels()
  // Also remove the unused index left by earlier releases.
  for (const path of [semanticDbPath(dbPath), semanticDbPath(dbPath).replace(/\.db$/, "-fast.db")]) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true })
  }
}
