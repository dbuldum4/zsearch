import type { Config } from "../config.ts"
import type { IndexStats } from "../index/db.ts"
import type { SearchDiagnosis } from "./diagnose.ts"
import type { Preview, RelatedResponse, SearchResponse, SemanticCoverage } from "./engine.ts"
import type { Mode } from "./query.ts"
import type { ReadOptions, ReadResult } from "./read.ts"

/** Index stats, with how far semantic search has caught up (`SearchEngine.semanticCoverage`). */
export type StatsWithSemantic = IndexStats & { semantic: Omit<SemanticCoverage, "matched"> | null }

export type SearchIn =
  | { type: "init"; dbPath: string; config: Config }
  | { type: "search"; qid: number; query: string; mode: Mode; limit: number; explain: boolean; groupDuplicates?: boolean }
  | { type: "related"; qid: number; source: number | string; limit: number }
  | { type: "cancelRelated"; request?: number }
  | { type: "explain"; qid: number; query: string; mode: Mode; limit: number }
  | { type: "preview"; qid: number; id: number; query: string; mode: Mode; focusLine?: number }
  | { type: "previews"; qid: number; ids: number[]; query: string; mode: Mode; focusLines?: (number | null)[] }
  | { type: "refresh"; force?: boolean }
  | { type: "config"; config: Config }
  | { type: "keepSemantic" }
  | { type: "opened"; path: string }
  | { type: "stats"; qid: number }
  | { type: "read"; qid: number; path: string; query: string; mode: Mode; opts: ReadOptions }

export type SearchOut =
  | { type: "ready"; files: number }
  | { type: "completed"; qid: number }
  | { type: "results"; qid: number; response: SearchResponse }
  | { type: "related"; qid: number; response: RelatedResponse }
  | { type: "diagnosis"; qid: number; diagnosis?: SearchDiagnosis }
  | { type: "preview"; qid: number; preview: Preview }
  | { type: "previews"; qid: number; previews: Preview[] }
  | { type: "refreshed"; files: number; changed: boolean }
  | { type: "stats"; qid: number; stats: StatsWithSemantic }
  | { type: "read"; qid: number; result: ReadResult | null; error?: string }
  | { type: "error"; qid?: number; error: string }
