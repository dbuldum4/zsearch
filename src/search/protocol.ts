import type { Config } from "../config.ts"
import type { IndexStats } from "../index/db.ts"
import type { Preview, SearchResponse } from "./engine.ts"
import type { Mode } from "./query.ts"
import type { ReadOptions, ReadResult } from "./read.ts"

export type SearchIn =
  | { type: "init"; dbPath: string; config: Config }
  | { type: "search"; qid: number; query: string; mode: Mode; limit: number }
  | { type: "preview"; qid: number; id: number; query: string; mode: Mode; focusLine?: number }
  | { type: "previews"; qid: number; ids: number[]; query: string; mode: Mode; focusLines?: (number | null)[] }
  | { type: "refresh"; force?: boolean }
  | { type: "config"; config: Config }
  | { type: "opened"; path: string }
  | { type: "stats"; qid: number }
  | { type: "read"; qid: number; path: string; query: string; mode: Mode; opts: ReadOptions }

export type SearchOut =
  | { type: "ready"; files: number }
  | { type: "results"; qid: number; response: SearchResponse }
  | { type: "preview"; qid: number; preview: Preview }
  | { type: "previews"; qid: number; previews: Preview[] }
  | { type: "refreshed"; files: number; changed: boolean }
  | { type: "stats"; qid: number; stats: IndexStats }
  | { type: "read"; qid: number; result: ReadResult | null; error?: string }
  | { type: "error"; qid?: number; error: string }
