/** Worker entry that owns the read side of the index and answers search/preview requests. */
import type { Config } from "../config.ts"
import { indexStats, openDb } from "../index/db.ts"
import { SearchEngine } from "./engine.ts"
import type { SearchIn, SearchOut } from "./protocol.ts"

declare const self: Worker

let engine: SearchEngine | null = null
let dbPath = ""
let latestSearch = 0
let latestPreview = 0
const send = (m: SearchOut) => postMessage(m)

// Idle work: decode stored texts into the engine's cache in small slices, only after a quiet
// second, so it never competes with a search.
let lastRequest = 0
let warmTimer: ReturnType<typeof setTimeout> | null = null
function scheduleWarm(delay: number) {
  if (warmTimer) clearTimeout(warmTimer)
  warmTimer = setTimeout(warmStep, delay)
}
function warmStep() {
  warmTimer = null
  if (!engine) return
  const quiet = Date.now() - lastRequest
  if (quiet < 1000) return scheduleWarm(1000 - quiet)
  if (engine.warmTexts(8)) scheduleWarm(2)
}

self.onmessage = async (ev: MessageEvent<SearchIn>) => {
  const msg = ev.data
  lastRequest = Date.now()
  try {
    switch (msg.type) {
      case "init": {
        dbPath = msg.dbPath
        engine = new SearchEngine(openDb(msg.dbPath), msg.config)
        send({ type: "ready", files: engine.catalog.size })
        break
      }
      case "search": {
        if (!engine) throw new Error("search worker not initialised")
        latestSearch = msg.qid
        const qid = msg.qid
        const response = await engine.search(msg.query, msg.mode, { limit: msg.limit, cancelled: () => latestSearch !== qid })
        if (latestSearch === qid) send({ type: "results", qid, response })
        break
      }
      case "preview": {
        if (!engine) throw new Error("search worker not initialised")
        latestPreview = msg.qid
        // Previews are cheap but arrive in bursts while scrolling; skip stale ones.
        await new Promise((r) => setTimeout(r, 0))
        if (latestPreview !== msg.qid) break
        send({ type: "preview", qid: msg.qid, preview: engine.preview(msg.id, msg.query, msg.mode, msg.focusLine) })
        break
      }
      case "refresh": {
        if (!engine) break
        const changed = engine.refresh(msg.force ?? false)
        send({ type: "refreshed", files: engine.catalog.size, changed })
        break
      }
      case "config": {
        if (!engine) break
        engine.config = msg.config as Config
        break
      }
      case "opened": {
        engine?.recordOpen(msg.path)
        break
      }
      case "stats": {
        if (!engine) break
        send({ type: "stats", qid: msg.qid, stats: indexStats(engine.db, dbPath) })
        break
      }
    }
  } catch (err) {
    send({ type: "error", qid: "qid" in msg ? (msg as { qid?: number }).qid : undefined, error: (err as Error).message })
  }
  // Any request may have picked up index changes (which empty the cache): warm it again once idle.
  scheduleWarm(1000)
}
