import { closeSync, openSync, readSync, constants } from "node:fs"
import { parse } from "exifr"
import { isMac } from "../../platform.ts"
import { cappedText, trackProcess } from "../../util/process.ts"

/** Small selected metadata, under the same worker deadline and content policy as extraction. */
export async function fileMetadata(path: string, ext: string): Promise<Record<string, string>> {
  const metadata: Record<string, string> = {}
  if (["jpg", "jpeg", "tif", "tiff", "heic", "avif", "png"].includes(ext)) {
    let fd: number | undefined
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const head = new Uint8Array(1024 * 1024), n = readSync(fd, head, 0, head.length, 0)
      const fields = await parse(head.subarray(0, n), ["Make", "Model", "ImageDescription", "Artist", "Copyright", "DateTimeOriginal", "UserComment"])
      for (const [k, v] of Object.entries(fields ?? {})) if (v !== undefined && v !== null) metadata[k] = String(v).slice(0, 2048)
    } catch {} finally { if (fd !== undefined) closeSync(fd) }
  }
  if (isMac) {
    const p = trackProcess(Bun.spawn(["/usr/bin/mdls", "-raw", "-name", "kMDItemUserTags", path], { stdout: "pipe", stderr: "ignore" }))
    const timer = setTimeout(() => p.kill(), 1000)
    try {
      const text = await cappedText(p.stdout, 8192, () => p.kill())
      await p.exited
      const tags = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\"/g, '"'))
      if (tags.length) metadata.tags = tags.join("\n")
    } catch {} finally { clearTimeout(timer) }
  }
  return metadata
}

export function metadataText(metadata: Record<string, string>): string {
  return Object.entries(metadata).map(([k, v]) => `${k}: ${v}`).join("\n")
}
