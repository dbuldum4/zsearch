import { existsSync, watch, type FSWatcher } from "node:fs"
import { dirname, join } from "node:path"
import ignore from "ignore"
import { type Config, resolvePath, paths } from "../config.ts"
import { SKIP_DIR_NAMES } from "../platform.ts"
import { under } from "./policy.ts"

/** Changed paths one refresh updates at most: beyond that it walks every root. */
const MAX_PATHS = 1000
/** Changed paths kept while a refresh waits, before those in busy folders are merged. */
const MAX_EVENTS = 10_000
/** Changed entries of one folder beyond which the folder is walked whole. */
const MAX_PER_DIR = 128

/**
 * Native recursive events (FSEvents on macOS), coalesced into an incremental index refresh of the
 * paths they name. `changed` gets null when the refresh should walk every root instead: after an
 * event without a path, a watcher error, or more changes than are worth listing.
 */
export class RootWatcher {
  private watchers: FSWatcher[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private key = ""
  private roots: string[] = []
  /** Paths changed since the last refresh; null when the next refresh walks every root. */
  private pending: Set<string> | null = new Set()
  constructor(private changed: (paths: string[] | null) => void | boolean, private delayMs = 1000, private maxWaitMs = 10_000) {}
  update(config: Config) {
    const key = JSON.stringify([config.roots, config.exclude, config.includeHidden, config.liveUpdates])
    if (key === this.key) return
    this.close(); this.key = key
    if (!config.liveUpdates) return
    const own = paths(), patterns = ignore().add(config.exclude.filter((p) => !p.startsWith("/") && !p.startsWith("~")))
    const absolute = config.exclude.filter((p) => p.startsWith("/") || p.startsWith("~")).map(resolvePath)
    this.roots = [...new Set(config.roots.map(resolvePath))]
    for (const root of this.roots) {
      let base = root
      while (!existsSync(base) && dirname(base) !== base) base = dirname(base)
      try {
        const watcher = watch(base, { recursive: true, persistent: false }, (_event, filename) => {
          if (!filename) return this.add(null)
          const path = join(base, String(filename))
          if (!under(path, root) || under(path, own.data) || under(path, own.config) || absolute.some((p) => under(path, p))) return
          const rel = path.slice(root.length).replace(/^\//, "")
          if (rel.split("/").some((part) => SKIP_DIR_NAMES.has(part))) return
          const ignoreFile = [".gitignore", ".ignore", ".zsearchignore"].includes(rel.split("/").at(-1) ?? "")
          if (!ignoreFile && !config.includeHidden && rel.split("/").some((s) => s.startsWith("."))) return
          if (!ignoreFile && rel && patterns.ignores(rel)) return
          this.add(path)
        })
        // Events may be lost from here on: the next refresh walks everything.
        watcher.on("error", () => { watcher.close(); this.add(null) })
        this.watchers.push(watcher)
      } catch { /* An unavailable root is retried by the normal refresh schedule. */ }
    }
  }
  private add(path: string | null) {
    this.carryOver(path === null ? null : [path])
    this.schedule()
  }
  /**
   * Paths a refresh did not finish updating (null: a walk of every root), cancelled, failed or
   * refused the index lock: the next refresh takes them in.
   */
  carryOver(paths: string[] | null) {
    if (paths === null) this.pending = null
    else if (this.pending) {
      for (const path of paths) this.pending.add(path)
      if (this.pending.size > MAX_EVENTS) this.pending = this.coalesce(this.pending)
    }
  }
  /**
   * The paths to update: those inside another left out, and a folder with many changes in place
   * of them. Null when too many remain.
   */
  private coalesce(changed: Set<string>): Set<string> | null {
    let current = changed
    for (;;) {
      const kept = [...current].filter((path) => {
        for (let dir = dirname(path); ; dir = dirname(dir)) {
          if (current.has(dir)) return false
          if (dir === dirname(dir)) return true
        }
      })
      const counts = new Map<string, number>()
      for (const path of kept) counts.set(dirname(path), (counts.get(dirname(path)) ?? 0) + 1)
      const busy = [...counts].filter(([dir, n]) => n > MAX_PER_DIR && this.roots.some((r) => under(dir, r))).map(([dir]) => dir)
      if (!busy.length) return kept.length > MAX_PATHS ? null : new Set(kept)
      current = new Set([...kept, ...busy])
    }
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.delayMs)
    this.timer.unref?.()
    // A busy log or build must not keep postponing the refresh until it goes quiet.
    this.maxTimer ??= setTimeout(() => this.flush(), this.maxWaitMs)
    this.maxTimer.unref?.()
  }
  private flush() {
    this.clearTimers()
    const changed = this.pending && this.coalesce(this.pending)
    if (changed?.size === 0) return
    if (this.changed(changed && [...changed]) === false) {
      this.pending = changed
      this.schedule()
    } else this.pending = new Set()
  }
  private clearTimers() {
    if (this.timer) clearTimeout(this.timer)
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.timer = this.maxTimer = null
  }
  close() {
    for (const w of this.watchers) w.close()
    this.watchers = []
    this.clearTimers()
    this.pending = new Set()
    this.key = ""
  }
}
