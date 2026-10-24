import type { Subprocess } from "bun"

type Message = Record<string, any>
type Child = Subprocess<"pipe", "pipe", "pipe">

/** A bounded JSON-lines test client that rejects callers when its child disappears. */
export function jsonLines(proc: Child) {
  let buffer = "", nextId = 0, closed: Error | undefined
  const queue: Message[] = [], notes: Message[] = []
  const readers: { resolve: (m: Message) => void; reject: (e: Error) => void }[] = []
  const pending = new Map<number, { resolve: (m: Message) => void; reject: (e: Error) => void }>()
  const stderr = new Response(proc.stderr).text()
  const fail = (error: Error) => {
    closed ??= error
    for (const reader of readers.splice(0)) reader.reject(closed)
    for (const request of pending.values()) request.reject(closed)
    pending.clear()
  }
  const deliver = (message: Message) => {
    const request = pending.get(message.id)
    if (request) {
      pending.delete(message.id)
      request.resolve(message)
    } else {
      notes.push(message)
      const reader = readers.shift()
      if (reader) reader.resolve(message)
      else queue.push(message)
    }
  }
  const reading = (async () => {
    const reader = proc.stdout.getReader(), decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          deliver(JSON.parse(buffer.slice(0, nl)))
          buffer = buffer.slice(nl + 1)
        }
      }
      fail(new Error("child closed stdout before replying"))
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    } finally { reader.releaseLock() }
  })()
  const send = (message: unknown) => {
    if (closed) throw closed
    proc.stdin.write(typeof message === "string" ? message + "\n" : JSON.stringify(message) + "\n")
    proc.stdin.flush()
  }
  const next = (): Promise<Message> => {
    if (queue.length) return Promise.resolve(queue.shift()!)
    if (closed) return Promise.reject(closed)
    return new Promise((resolve, reject) => readers.push({ resolve, reject }))
  }
  const until = async (predicate: (message: Message) => boolean): Promise<Message> => {
    const timer = setTimeout(() => fail(new Error("timed out waiting for a child message")), 60_000)
    try {
      for (;;) {
        const message = await next()
        if (predicate(message)) return message
      }
    } finally { clearTimeout(timer) }
  }
  const request = (method: string, params: unknown = {}): Promise<Message> => {
    if (closed) return Promise.reject(closed)
    const id = ++nextId
    const timer = setTimeout(() => fail(new Error(`timed out waiting for ${method}`)), 90_000)
    const reply = new Promise<Message>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try { send({ jsonrpc: "2.0", id, method, params }) } catch (error) { fail(error as Error) }
    })
    return reply.finally(() => clearTimeout(timer))
  }
  return {
    proc, send, until, request, notes, stderr,
    reply: (id: number) => until((m) => m.id === id),
    async close() {
      proc.stdin.end()
      await proc.exited
      await reading
    },
    async dispose() {
      fail(new Error("test client disposed"))
      if (proc.exitCode === null) proc.kill()
      await proc.exited
      await reading
      await stderr
    },
  }
}
