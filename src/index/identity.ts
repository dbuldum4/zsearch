import { statSync } from "node:fs"

/** Metadata change identity, at the filesystem/runtime's precision; not a content digest. */
export interface FileIdentity {
  dev: number
  ino: number
  size: number
  mtime: number
  ctime: number | null
}

export function fileIdentityCurrent(path: string, expected: FileIdentity): boolean {
  if (expected.ctime === null || !expected.ino) return false
  try {
    const st = statSync(path)
    return st.isFile() && st.dev === expected.dev && st.ino === expected.ino && st.size === expected.size
      && Math.floor(st.mtimeMs) === expected.mtime && st.ctimeMs === expected.ctime
  } catch { return false }
}
