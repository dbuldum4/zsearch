import { existsSync, watch, type FSWatcher } from "node:fs"
import { dirname, join } from "node:path"
import ignore from "ignore"
import { type Config, resolvePath, paths } from "../config.ts"
import { SKIP_DIR_NAMES } from "../platform.ts"
import { under } from "./policy.ts"

/** Native recursive events (FSEvents on macOS), coalesced into an incremental index refresh. */
export class RootWatcher {
  private watchers: FSWatcher[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private key = ""
  constructor(private changed: () => void | boolean, private delayMs = 1000) {}
  update(config: Config) {
    const key = JSON.stringify([config.roots, config.exclude, config.includeHidden, config.liveUpdates])
    if (key === this.key) return
    this.close(); this.key = key
    if (!config.liveUpdates) return
    const own = paths(), patterns = ignore().add(config.exclude.filter((p) => !p.startsWith("/") && !p.startsWith("~")))
    const absolute = config.exclude.filter((p) => p.startsWith("/") || p.startsWith("~")).map(resolvePath)
    for (const root of [...new Set(config.roots.map(resolvePath))]) {
      let base = root
      while (!existsSync(base) && dirname(base) !== base) base = dirname(base)
      try {
        const watcher = watch(base, { recursive: true, persistent: false }, (_event, filename) => {
          const path = filename ? join(base, String(filename)) : root
          if (!under(path, root) || under(path, own.data) || under(path, own.config) || absolute.some((p) => under(path, p))) return
          const rel = path.slice(root.length).replace(/^\//, "")
          if (rel.split("/").some((part) => SKIP_DIR_NAMES.has(part))) return
          const ignoreFile = [".gitignore", ".ignore", ".zsearchignore"].includes(rel.split("/").at(-1) ?? "")
          if (!ignoreFile && !config.includeHidden && rel.split("/").some((s) => s.startsWith("."))) return
          if (!ignoreFile && rel && patterns.ignores(rel)) return
          this.schedule()
        })
        watcher.on("error", () => watcher.close())
        this.watchers.push(watcher)
      } catch { /* An unavailable root is retried by the normal refresh schedule. */ }
    }
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.changed() === false) this.schedule()
    }, this.delayMs)
    this.timer.unref?.()
  }
  close() {
    for (const w of this.watchers) w.close()
    this.watchers = []
    if (this.timer) clearTimeout(this.timer)
    this.timer = null; this.key = ""
  }
}
