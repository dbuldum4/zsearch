import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import { dirname } from "node:path"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** PID of the process currently indexing, or null. */
export function lockHolder(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, "utf8").trim())
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null
  } catch {
    return null
  }
}

/** Take the indexing lock. Returns a release function, or null if another live process holds it. */
export function acquireLock(path: string): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx")
      writeSync(fd, String(process.pid))
      closeSync(fd)
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path, { force: true })
        } catch {
          // already gone
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
      if (lockHolder(path) !== null) return null
      rmSync(path, { force: true }) // stale lock from a crashed run
    }
  }
  return null
}
