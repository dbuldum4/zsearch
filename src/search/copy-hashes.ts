import { createHash, type Hash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"

/** A file to hash, as `stat` saw it: hashing gives up if the path is no longer this file. */
export interface HashTarget {
  path: string
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

type FileStat = Omit<HashTarget, "path"> & { isFile(): boolean }

export interface OpenedFile {
  stat(): Promise<FileStat>
  /** Reads into `buffer` from `position`; the bytes read, 0 at the end. */
  read(buffer: Uint8Array, position: number): Promise<number>
  close(): Promise<void>
}

export type FileOpener = (path: string) => Promise<OpenedFile>

const openFile: FileOpener = async (path) => {
  // O_NONBLOCK: a FIFO in place of the file would otherwise block the open until a writer comes.
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  return {
    stat: () => fh.stat(),
    read: async (buffer, position) => (await fh.read(buffer, 0, buffer.length, position)).bytesRead,
    close: () => fh.close(),
  }
}

const identity = (t: Omit<HashTarget, "path">) => `${t.dev}:${t.ino}:${t.size}:${t.mtimeMs}:${t.ctimeMs}`
const same = (a: Omit<HashTarget, "path">, b: Omit<HashTarget, "path">) => identity(a) === identity(b)

const CHUNK = 256 * 1024
const STALLED = Symbol("stalled")

interface Job {
  target: HashTarget
  hash: Hash
  position: number
}

export interface CopyHashOptions {
  open?: FileOpener
  /** How long hashing goes on after the last request for it. */
  backgroundMs?: number
  /** An open, stat or read taking longer than this gives the file up, for `retryMs`. */
  stallMs?: number
  retryMs?: number
  /** Hashes kept; partial hashes kept are a fraction of it. */
  maxEntries?: number
}

/**
 * SHA-256 of files for grouping identical copies, by file identity (device, inode, size, mtime,
 * ctime). Reads are asynchronous and one at a time, smallest file first, so a large or stalled
 * file never holds up a search, which waits only as long as it chooses. Hashing goes on in the
 * background for a while after each request, and a file left half read resumes where it stopped.
 */
export class CopyHashes {
  private digests = new Map<string, string>()
  private partial = new Map<string, Job>()
  private stalled = new Map<string, number>()
  private wanted: HashTarget[] = []
  private until = 0
  private running = false
  private waiters = new Set<() => void>()
  private buffer = new Uint8Array(CHUNK)
  private readonly open: FileOpener
  private readonly backgroundMs: number
  private readonly stallMs: number
  private readonly retryMs: number
  private readonly maxEntries: number

  constructor(opts: CopyHashOptions = {}) {
    this.open = opts.open ?? openFile
    this.backgroundMs = opts.backgroundMs ?? 2000
    this.stallMs = opts.stallMs ?? 2000
    this.retryMs = opts.retryMs ?? 10 * 60_000
    this.maxEntries = opts.maxEntries ?? 20_000
  }

  get(target: Omit<HashTarget, "path">): string | undefined {
    return this.digests.get(identity(target))
  }

  /**
   * Hash `targets` (instead of any asked for before) and wait until they are hashed, given up
   * on, or `deadline` (a `performance.now()` time) comes.
   */
  async hash(targets: HashTarget[], deadline: number): Promise<void> {
    const now = performance.now()
    const unique = new Map<string, HashTarget>()
    for (const t of targets) {
      const key = identity(t), stalledAt = this.stalled.get(key)
      if (this.digests.has(key) || (stalledAt !== undefined && now - stalledAt < this.retryMs)) continue
      unique.set(key, t)
    }
    this.wanted = [...unique.values()].sort((a, b) => a.size - b.size)
    if (!this.wanted.length) return
    this.until = now + this.backgroundMs
    if (!this.running) void this.pump()
    const wanted = this.wanted
    while (wanted.some((t) => this.wanted.includes(t)) && performance.now() < deadline) {
      let wake = () => {}
      const timer = setTimeout(() => wake(), Math.min(Math.max(0, deadline - performance.now()), 2 ** 31 - 1))
      await new Promise<void>((resolve) => { wake = resolve; this.waiters.add(resolve) })
      clearTimeout(timer)
      this.waiters.delete(wake)
    }
  }

  private async pump() {
    this.running = true
    try {
      while (this.wanted.length && performance.now() < this.until) {
        const target = this.wanted[0]!
        if (await this.advance(target)) this.wanted = this.wanted.filter((t) => t !== target)
        for (const wake of this.waiters) wake()
      }
    } finally {
      this.running = false
    }
  }

  /** Read on in `target` while it comes first; true once it is hashed or given up. */
  private async advance(target: HashTarget): Promise<boolean> {
    const key = identity(target)
    const job = this.partial.get(key) ?? { target, hash: createHash("sha256"), position: 0 }
    this.partial.delete(key)
    let file: OpenedFile | undefined
    let pending: Promise<unknown> | undefined
    const timed = <T>(p: Promise<T>): Promise<T> => {
      pending = p
      let timer: ReturnType<typeof setTimeout> | undefined
      const stall = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(STALLED), this.stallMs) })
      return Promise.race([p, stall]).finally(() => clearTimeout(timer))
    }
    try {
      const opening = this.open(target.path)
      file = await timed(opening)
      const before = await timed(file.stat())
      if (!before.isFile() || !same(before, target)) return true
      while (job.position < target.size) {
        if (this.wanted[0] !== target || performance.now() >= this.until) {
          this.keepPartial(key, job)
          return false
        }
        const n = await timed(file.read(this.buffer.subarray(0, Math.min(CHUNK, target.size - job.position)), job.position))
        if (!n) return true
        job.hash.update(this.buffer.subarray(0, n))
        job.position += n
      }
      if (same(await timed(file.stat()), target)) this.remember(key, job.hash.digest("hex"))
      return true
    } catch (err) {
      if (err === STALLED) {
        this.stalled.set(key, performance.now())
        if (this.stalled.size > this.maxEntries) this.stalled.delete(this.stalled.keys().next().value!)
        // The stalled call still owns the buffer and the file: both are let go of only when it ends.
        this.buffer = new Uint8Array(CHUNK)
        const f = file
        const release = () => { if (f) void f.close().catch(() => {}) }
        if (f) void pending?.then(release, release)
        else void (pending as Promise<OpenedFile> | undefined)?.then((late) => late.close().catch(() => {}), () => {})
        file = undefined
      }
      return true
    } finally {
      if (file) await file.close().catch(() => {})
    }
  }

  private keepPartial(key: string, job: Job) {
    this.partial.set(key, job)
    if (this.partial.size > Math.max(1, this.maxEntries >> 9)) this.partial.delete(this.partial.keys().next().value!)
  }

  private remember(key: string, digest: string) {
    this.digests.set(key, digest)
    if (this.digests.size > this.maxEntries) this.digests.delete(this.digests.keys().next().value!)
  }
}
