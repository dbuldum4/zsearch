import type { Config } from "../config.ts"
import type { IndexStats } from "../index/db.ts"
import type { Preview, SearchResponse } from "./engine.ts"
import type { Mode } from "./query.ts"

export type SearchIn =
  | { type: "init"; dbPath: string; config: Config }
  | { type: "search"; qid: number; query: string; mode: Mode; limit: number }
  | { type: "preview"; qid: number; id: number; query: string; mode: Mode; focusLine?: number }
  | { type: "refresh"; force?: boolean }
  | { type: "config"; config: Config }
  | { type: "opened"; path: string }
  | { type: "stats"; qid: number }

export type SearchOut =
  | { type: "ready"; files: number }
  | { type: "results"; qid: number; response: SearchResponse }
  | { type: "preview"; qid: number; preview: Preview }
  | { type: "refreshed"; files: number; changed: boolean }
  | { type: "stats"; qid: number; stats: IndexStats }
  | { type: "error"; qid?: number; error: string }
