/**
 * URL of a worker entry point given its path relative to `src/`.
 * From source, resolve against this file. In a compiled binary, bundled code reports the
 * executable as its module URL, and worker entry points live at their `src/`-relative
 * path inside Bun's embedded file system.
 */
export function workerUrl(rel: string): string {
  const here = import.meta.url
  const marker = "/$bunfs/root/"
  const i = here.indexOf(marker)
  if (i >= 0) return here.slice(0, i + marker.length) + rel
  return new URL(`../${rel}`, here).href
}
