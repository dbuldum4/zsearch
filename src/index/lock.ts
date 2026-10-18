import { closeSync, constants, fchmodSync, ftruncateSync, mkdirSync, openSync, readSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { dlopen, FFIType } from "bun:ffi"

const symbols = { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } } as const
const lib = (() => {
  if (process.platform === "darwin") return dlopen("/usr/lib/libSystem.B.dylib", symbols)
  try { return dlopen("libc.so.6", symbols) }
  catch { return dlopen(`/lib/libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`, symbols) }
})()
const LOCK_SH = 1, LOCK_EX = 2, LOCK_NB = 4
const tryLock = (fd: number, mode: number) => lib.symbols.flock(fd, mode | LOCK_NB) === 0
// A holder writes its pid just after locking and clears it just before unlocking.
const SETTLE_TRIES = 20, SETTLE_MS = 5

function holder(fd: number): { pid: number; legacy: boolean } | null {
  try {
    const buf = Buffer.alloc(64)
    const value = JSON.parse(buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0)).trim())
    const pid = typeof value === "number" ? value : value.pid
    return Number.isInteger(pid) && pid > 0 ? { pid, legacy: typeof value === "number" } : null
  } catch { return null }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM" }
}

/**
 * Kernel-held locks cannot be confused with a reused PID. Old PID-only locks still work.
 * Probes take a shared lock, so they never block each other and only briefly delay a writer.
 * Returns -1 when the lock is held but its holder never wrote a readable pid.
 */
export function lockHolder(path: string): number | null {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    for (let tries = 0; ; tries++) {
      if (tryLock(fd, LOCK_SH)) {
        const owner = holder(fd)
        return owner?.legacy && alive(owner.pid) ? owner.pid : null
      }
      const owner = holder(fd)
      if (owner && (alive(owner.pid) || tries >= SETTLE_TRIES)) return owner.pid
      if (tries >= SETTLE_TRIES) return -1
      Bun.sleepSync(SETTLE_MS)
    }
  } catch { return null }
  finally { if (fd !== undefined) closeSync(fd) }
}

/**
 * Keep the lock inode in place: unlinking it permits two writers to lock different inodes.
 * `waitMs`: how long to wait for another holder to let go before giving up.
 */
export function acquireLock(path: string, waitMs = SETTLE_TRIES * SETTLE_MS): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    fchmodSync(fd, 0o600)
    let locked = tryLock(fd, LOCK_EX)
    for (const end = Date.now() + waitMs; !locked && Date.now() < end; ) {
      Bun.sleepSync(SETTLE_MS)
      locked = tryLock(fd, LOCK_EX)
    }
    if (!locked) { closeSync(fd); return null }
    const owner = holder(fd)
    if (owner?.legacy && alive(owner.pid)) { closeSync(fd); return null }
    ftruncateSync(fd, 0)
    writeSync(fd, JSON.stringify({ pid: process.pid }), 0, "utf8")
  } catch (e) {
    closeSync(fd)
    throw e
  }
  let released = false
  return () => {
    if (released) return
    released = true
    ftruncateSync(fd, 0)
    closeSync(fd)
  }
}
