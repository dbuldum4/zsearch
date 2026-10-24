import { expect, test } from "bun:test"
import { jsonLines } from "./helpers/json-lines.ts"

test("an outstanding protocol request rejects when its child exits", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
    console.log(JSON.stringify({ type: "ready" }))
    for await (const _ of Bun.stdin.stream()) process.exit(7)
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const client = jsonLines(child)
  try {
    await client.until((m) => m.type === "ready")
    await expect(client.request("never-answered")).rejects.toThrow("closed stdout")
    expect(await child.exited).toBe(7)
    await expect(client.request("after-exit")).rejects.toThrow("closed stdout")
  } finally { await client.dispose() }
}, 10_000)
