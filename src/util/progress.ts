import type { IndexProgress } from "../index/indexer.ts"
import { tildify } from "../config.ts"
import { formatBytes, formatCount, formatDuration } from "./text.ts"

export function progressLine(p: IndexProgress): string {
  switch (p.phase) {
    case "starting":
    case "scan":
      return `Scanning… ${formatCount(p.scanned)} items  ${tildify(p.current)}`
    case "content": {
      if (p.waiting) return `Waiting: ${p.waiting} · ${formatCount(p.contentDone)}/${formatCount(p.contentTotal)} files read`
      const pct = p.contentTotal ? Math.floor((p.contentDone / p.contentTotal) * 100) : 100
      return `Reading contents ${pct}%  ${formatCount(p.contentDone)}/${formatCount(p.contentTotal)} · ${formatBytes(p.contentBytes)}  ${tildify(p.current)}`
    }
    case "cleanup":
      return `Cleaning up ${formatCount(p.removed)} removed files…`
    default:
      return `${p.phase} in ${formatDuration(p.elapsedMs)}`
  }
}
