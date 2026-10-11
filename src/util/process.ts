/** Bound subprocess output before converting it to strings. */
export async function cappedText(stream: ReadableStream<Uint8Array>, maxBytes: number, kill: () => void): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) { kill(); throw new Error("extraction output exceeds size budget") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(total)
  let pos = 0
  for (const c of chunks) { bytes.set(c, pos); pos += c.length }
  return new TextDecoder().decode(bytes)
}

let observer: ((pid: number, running: boolean) => void) | undefined
export function observeProcesses(next: typeof observer) { observer = next }
export function trackProcess<T extends { pid: number; exited: Promise<number> }>(process: T): T {
  observer?.(process.pid, true)
  void process.exited.finally(() => observer?.(process.pid, false))
  return process
}
