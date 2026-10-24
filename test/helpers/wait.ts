/** Poll an observable event; the deadline diagnoses a missing event, not its expected speed. */
export async function waitFor(condition: () => boolean, message: string, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${message}`)
    await Bun.sleep(10)
  }
}
