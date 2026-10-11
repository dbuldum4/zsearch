import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs"

/** Bound the actual opened file, rather than trusting a size from an earlier crawl. */
export function boundedFile(path: string, maxBytes: number): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("file exceeds read size budget")
    const bytes = new Uint8Array(stat.size)
    let read = 0
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, read)
      if (!n) break
      read += n
    }
    return bytes.subarray(0, read)
  } finally { closeSync(fd) }
}
