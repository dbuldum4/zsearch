import { closeSync, constants, fchmodSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { dlopen, FFIType } from "bun:ffi"

const symbols = { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } } as const
const lib = (() => {
  if (process.platform === "darwin") return dlopen("/usr/lib/libSystem.B.dylib", symbols)
  try { return dlopen("libc.so.6", symbols) }
  catch { return dlopen(`/lib/libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`, symbols) }
})()
const exclusive = (fd: number) => lib.symbols.flock(fd, 2 | 4) === 0

function holder(raw: string): { pid: number; legacy: boolean } | null {
  try {
    const value = JSON.parse(raw)
    const pid = typeof value === "number" ? value : value.pid
    return Number.isInteger(pid) && pid > 0 ? { pid, legacy: typeof value === "number" } : null
  } catch { return null }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM" }
}

/** Kernel-held locks cannot be confused with a reused PID. Old PID-only locks still work. */
export function lockHolder(path: string): number | null {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW)
    const owner = holder(readFileSync(fd, "utf8").trim())
    if (!exclusive(fd)) return owner?.pid ?? null
    return owner?.legacy && alive(owner.pid) ? owner.pid : null
  } catch { return null }
  finally { if (fd !== undefined) closeSync(fd) }
}

/** Keep the lock inode in place: unlinking it permits two writers to lock different inodes. */
export function acquireLock(path: string): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  fchmodSync(fd, 0o600)
  if (!exclusive(fd)) { closeSync(fd); return null }
  const owner = holder(readFileSync(fd, "utf8").trim())
  if (owner?.legacy && alive(owner.pid)) { closeSync(fd); return null }
  ftruncateSync(fd, 0)
  writeSync(fd, JSON.stringify({ pid: process.pid }), 0, "utf8")
  let released = false
  return () => {
    if (released) return
    released = true
    ftruncateSync(fd, 0)
    closeSync(fd)
  }
}
