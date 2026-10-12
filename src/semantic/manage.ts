/** Turning search by meaning on and off, and what to say about it (CLI, app, MCP). */
import { rmSync } from "node:fs"
import type { Config } from "../config.ts"
import { embedToolPath } from "./helper.ts"
import { semanticAvailable } from "./indexer.ts"
import { installedModel, MEDIA_MODEL, modelDir, removeModel, TEXT_MODEL } from "./model.ts"
import { openSemanticDb, semanticDbPath, type SemanticStats, semanticStats } from "./store.ts"

export interface SemanticStatus {
  enabled: boolean
  images: boolean
  code: boolean
  /** The embedding helper, if there is one. */
  helper: string | null
  modelDir: string
  model: { text: boolean; media: boolean; textBytes: number; mediaBytes: number }
  /** Why indexing for meaning doesn't run, or null when it does. */
  blocked: string | null
  index: SemanticStats | null
}

export function semanticStatus(config: Config, dbPath: string): SemanticStatus {
  const model = installedModel()
  const tool = embedToolPath()
  let index: SemanticStats | null = null
  const path = semanticDbPath(dbPath)
  try {
    const db = openSemanticDb(path, { readonly: true })
    if (db) {
      try { index = semanticStats(db, path) } finally { db.close() }
    }
  } catch {}
  return {
    enabled: config.semantic.enabled,
    images: config.semantic.images,
    code: config.semantic.code,
    helper: tool,
    modelDir: modelDir(),
    model: { text: model.text !== null, media: model.media !== null, textBytes: TEXT_MODEL.bytes, mediaBytes: MEDIA_MODEL.bytes },
    blocked: semanticAvailable(config, tool),
    index,
  }
}

/** Delete the model and the semantic index (the setting is the caller's to turn off). */
export function removeSemantic(dbPath: string): void {
  removeModel()
  const path = semanticDbPath(dbPath)
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true })
}
