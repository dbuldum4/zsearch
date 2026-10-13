import { expect, test } from "bun:test"
import { join } from "node:path"

test("meaning-only indexing, updates and rebuilds never create a word index", async () => {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/meaning-only.ts")], {
    env: { ...process.env, ZSEARCH_MEANING_ONLY: "1" }, stdout: "pipe", stderr: "pipe",
  })
  const [status, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
  expect({ status, out, err }).toEqual({ status: 0, out: "meaning-only OK\n", err: "" })
}, 60000)
