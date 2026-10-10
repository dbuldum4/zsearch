import { availableParallelism } from "node:os"
import { dlopen, FFIType } from "bun:ffi"

/**
 * How much of the computer indexing may use (the `indexLoad` setting): a share of its cores, of
 * its CPU time and, below the whole, a lower disk priority. Between 0.1 and 1.
 */
export function loadShare(percent: number): number {
  return Number.isFinite(percent) ? Math.min(1, Math.max(0.1, percent / 100)) : 1
}

/**
 * Extraction workers for a share of `cores`: the cores less two (the indexer's thread and the
 * writer's, which keep one each busy), at most 8, and with the writer's thread no more than the
 * share of the cores, rounded.
 */
export function defaultWorkers(share: number, cores = availableParallelism()): number {
  return Math.max(1, Math.min(8, cores - 2, Math.round(cores * share) - 1))
}

/**
 * Keeps the CPU time this process takes, all its threads together, to a share of the
 * computer's: `over` says when the last second or so took more, and no new work should start.
 */
export class CpuBudget {
  private limit: number
  /** Recent samples of the time and the CPU time taken, in microseconds, oldest first. */
  private samples: { at: number; cpu: number }[] = []

  constructor(share: number, cores = availableParallelism()) {
    this.limit = share >= 1 ? Infinity : share * cores
  }

  get over(): boolean {
    if (this.limit === Infinity) return false
    const at = performance.now() * 1000
    const u = process.cpuUsage()
    const now = { at, cpu: u.user + u.system }
    const s = this.samples
    if (!s.length || at - s[s.length - 1]!.at >= 50_000) s.push(now)
    while (s.length > 2 && at - s[1]!.at >= 1_000_000) s.shift()
    const first = s[0]!
    // Too short a time says little: a few busy threads look like the whole computer.
    if (at - first.at < 200_000) return false
    return (now.cpu - first.cpu) / (at - first.at) > this.limit
  }
}

/**
 * Lower the calling thread's disk priority: the system serves other programs' reads and writes
 * first, and slows this thread's down while they need the disk. Best effort: false if the
 * system has no such setting, or refused it.
 */
export function backgroundDisk(): boolean {
  try {
    if (process.platform === "darwin") {
      const lib = dlopen("/usr/lib/libSystem.B.dylib", { setiopolicy_np: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
      // IOPOL_TYPE_DISK, IOPOL_SCOPE_THREAD, IOPOL_UTILITY: what macOS gives background work such as indexing.
      const ok = lib.symbols.setiopolicy_np(0, 1, 4) === 0
      lib.close()
      return ok
    }
    if (process.platform === "linux") {
      const ioprioSet = process.arch === "x64" ? 251 : process.arch === "arm64" ? 30 : 0
      if (!ioprioSet) return false
      const lib = dlopen("libc.so.6", { syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 } })
      // ioprio_set(IOPRIO_WHO_PROCESS, 0: this thread, best-effort class, its lowest level)
      const ok = Number(lib.symbols.syscall(ioprioSet, 1, 0, (2 << 13) | 7)) === 0
      lib.close()
      return ok
    }
  } catch {
    // no FFI, or no such library: priority stays as it is
  }
  return false
}
