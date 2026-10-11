/**
 * Machine-made dataset folders: hundreds of images named by a program (`frame_000123.png`,
 * hashes, UUIDs), such as an ML dataset in Downloads. OCR leaves them out, for it would cost a
 * fraction of a second per image to find little or no text; their names stay searchable.
 */
import { extOf, OCR_EXTS } from "../kinds.ts"

/** Images in one folder, at least, for it to count as a dataset. */
export const DATASET_MIN_IMAGES = 300
/** The share of them, at least, with machine-made names. */
export const DATASET_MACHINE_SHARE = 0.7

/**
 * Names cameras, phones and scanners give: photos and scans people want read even though a
 * program numbered them (`IMG_1234`, `DSC01234`, `PXL_20240101_…`, `scan0001`, `page_001`).
 */
const DEVICE_PREFIX = /^(?:img|dsc[nf]?|pxl|mvimg|gopr|gh|dji|sam|wp|p|photo|scan|page|screenshot|capture)[_-]?\d/i
/**
 * Phones that name photos by when they were taken: `20230512_143022` (Samsung and other Android
 * cameras, optionally with a burst number) and milliseconds since 1970 (`1699999999123`).
 */
const DEVICE_TIME = /^(?:(?:19|20)\d{6}[_-]\d{6}(?:[_-]?\d{1,3})?|1\d{12})(?:\(\d+\))?$/
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{16,}$/i

/** Was this file named by a program rather than a person or a camera? */
export function machineNamed(name: string): boolean {
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  if (/\s/.test(stem) || DEVICE_PREFIX.test(stem) || DEVICE_TIME.test(stem)) return false
  if (UUID.test(stem) || HASH.test(stem)) return true
  // Mostly digits: "000123", "frame_000123", "n01440764_10026", "cat.1234".
  let digits = 0
  for (let i = 0; i < stem.length; i++) { const c = stem.charCodeAt(i); if (c >= 48 && c <= 57) digits++ }
  return digits >= 4 && digits * 2 >= stem.length
}

export interface DatasetFolder {
  dir: string
  images: number
}

/**
 * The dataset folders among these image paths: folders, other than the indexed folders
 * themselves, with `DATASET_MIN_IMAGES` OCR images or more directly in them, mostly machine-named.
 */
export function datasetFolders(paths: Iterable<string>, roots: string[]): DatasetFolder[] {
  const byDir = new Map<string, { images: number; machine: number }>()
  for (const path of paths) {
    const slash = path.lastIndexOf("/")
    const name = path.slice(slash + 1)
    if (!OCR_EXTS.has(extOf(name))) continue
    const dir = slash <= 0 ? "/" : path.slice(0, slash)
    let c = byDir.get(dir)
    if (!c) byDir.set(dir, (c = { images: 0, machine: 0 }))
    c.images++
    if (machineNamed(name)) c.machine++
  }
  const rootSet = new Set(roots)
  const out: DatasetFolder[] = []
  for (const [dir, c] of byDir) {
    if (rootSet.has(dir) || c.images < DATASET_MIN_IMAGES || c.machine < c.images * DATASET_MACHINE_SHARE) continue
    out.push({ dir, images: c.images })
  }
  return out.sort((a, b) => (a.dir < b.dir ? -1 : 1))
}

/** Why an image in such a folder was not read, as status shows it. */
export const DATASET_NOTE = "dataset"
