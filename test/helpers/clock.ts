import { spyOn } from "bun:test"

/** Control the parent thread's deadlines without changing worker threads' clocks. */
export function testClock() {
  let now = Date.now(), next = 0
  const timers = new Map<number, { at: number; callback: () => void; interval?: number }>()
  const schedule = (callback: () => void, delay: number, interval?: number) => {
    const id = ++next
    timers.set(id, { at: now + delay, callback, interval })
    return id
  }
  const mocks = [
    spyOn(Date, "now").mockImplementation(() => now),
    spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay = 0) => schedule(callback, delay)) as unknown as typeof setTimeout),
    spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => { timers.delete(Number(id)) }) as typeof clearTimeout),
    spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay = 0) => schedule(callback, Math.max(1, delay), Math.max(1, delay))) as unknown as typeof setInterval),
    spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => { timers.delete(Number(id)) }) as typeof clearInterval),
  ]
  return {
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!due) break
        const [id, timer] = due
        now = timer.at
        if (timer.interval) timer.at += timer.interval
        else timers.delete(id)
        timer.callback()
      }
      now = end
    },
    restore() {
      for (const mock of mocks) mock.mockRestore()
      timers.clear()
    },
  }
}
