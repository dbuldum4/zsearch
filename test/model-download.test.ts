import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brotliCompressSync, gzipSync } from "node:zlib"
import { downloadModels, MODELS, type ModelSpec } from "../src/semantic/model.ts"
import { fetchIdentity } from "../src/util/fetch.ts"

const originalModels = [...MODELS]
const savedHome = process.env.ZSEARCH_HOME
const savedModels = process.env.ZSEARCH_MODELS
const payload = Buffer.from("A small deterministic model fixture.\n")
const spec: ModelSpec = {
  name: "test-model", repository: "test/model", revision: "fixed", license: "MIT", folder: "test-model",
  files: [{ name: "test.gguf", bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") }],
}
let dir: string
let stop: (() => void) | undefined
beforeEach(() => {
  dir = mkdtempSync(join(process.env.ZSEARCH_TEST_TMP || tmpdir(), "zsearch-download-"))
  process.env.ZSEARCH_HOME = dir
  process.env.ZSEARCH_MODELS = join(dir, "models")
  mkdirSync(process.env.ZSEARCH_MODELS, { recursive: true })
  MODELS.splice(0, MODELS.length, spec)
})
afterEach(() => {
  stop?.(); stop = undefined
  MODELS.splice(0, MODELS.length, ...originalModels)
  if (savedHome === undefined) delete process.env.ZSEARCH_HOME; else process.env.ZSEARCH_HOME = savedHome
  if (savedModels === undefined) delete process.env.ZSEARCH_MODELS; else process.env.ZSEARCH_MODELS = savedModels
  rmSync(dir, { recursive: true, force: true })
})
function serve(handler: (request: Request) => Response) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  stop = () => server.stop(true)
  return server.url
}
function redirectedFetch(url: URL): typeof fetch {
  return ((_: unknown, init?: RequestInit) => fetch(url, init)) as typeof fetch
}
const final = () => join(process.env.ZSEARCH_MODELS!, "test.gguf")

describe("identity-only model downloads", () => {
  for (const encoding of ["br", "gzip", "Br, identity"]) {
    test(`rejects a server that ignores identity negotiation and sends ${encoding}`, async () => {
      const url = serve((request) => {
        expect(request.headers.get("accept-encoding")).toBe("identity")
        return new Response(encoding === "gzip" ? gzipSync(payload) : brotliCompressSync(payload), { headers: { "Content-Encoding": encoding } })
      })
      await expect(downloadModels({ fetchImpl: redirectedFetch(url) })).rejects.toThrow("refused compressed response")
      expect(existsSync(final())).toBe(false)
      expect(existsSync(`${final()}.part`)).toBe(false)
    })
  }
  test("keeps decompression disabled across a redirect to a Brotli response", async () => {
    const url = serve((request) => new URL(request.url).pathname === "/"
      ? new Response(null, { status: 302, headers: { Location: "/compressed" } })
      : new Response(brotliCompressSync(payload), { headers: { "Content-Encoding": "br" } }))
    await expect(downloadModels({ fetchImpl: redirectedFetch(url) })).rejects.toThrow("refused compressed response")
    expect(existsSync(final())).toBe(false)
  })
  test("resumes the raw download and verifies its original checksum", async () => {
    const have = 9
    writeFileSync(`${final()}.part`, payload.subarray(0, have))
    const controller = new AbortController()
    const url = serve((request) => {
      expect(request.headers.get("range")).toBe(`bytes=${have}-`)
      expect(request.headers.get("accept-encoding")).toBe("identity")
      return new Response(payload.subarray(have), { status: 206, headers: { "Content-Encoding": "Identity" } })
    })
    let progress = 0
    await downloadModels({ fetchImpl: redirectedFetch(url), signal: controller.signal, onProgress: (event) => { progress = event.received } })
    expect(readFileSync(final())).toEqual(payload)
    expect(progress).toBe(payload.length)
    expect(existsSync(`${final()}.part`)).toBe(false)
  })
  test("restarts when the server sends the full raw body instead of a range", async () => {
    writeFileSync(`${final()}.part`, payload.subarray(0, 5))
    let calls = 0
    const url = serve(() => { calls++; return new Response(payload) })
    await downloadModels({ fetchImpl: redirectedFetch(url) })
    expect(calls).toBe(2)
    expect(readFileSync(final())).toEqual(payload)
  })
  test("still rejects raw data with the right size and wrong checksum", async () => {
    const url = serve(() => new Response(Buffer.alloc(payload.length, 1)))
    await expect(downloadModels({ fetchImpl: redirectedFetch(url) })).rejects.toThrow("did not match its checksum")
    expect(existsSync(final())).toBe(false)
    expect(existsSync(`${final()}.part`)).toBe(false)
  })
  test("passes caller cancellation to the runtime", async () => {
    const controller = new AbortController()
    controller.abort()
    const url = serve(() => new Response(payload))
    await expect(downloadModels({ fetchImpl: redirectedFetch(url), signal: controller.signal })).rejects.toThrow()
    expect(existsSync(final())).toBe(false)
  })
  test("cancels a rejected response before a consumer can read the body", async () => {
    let cancelled = false
    const response = new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { "Content-Encoding": "br" } })
    const rawFetch = (async (_: unknown, init?: RequestInit) => {
      expect((init as RequestInit & { decompress: boolean }).decompress).toBe(false)
      expect(new Headers(init?.headers).get("accept-encoding")).toBe("identity")
      return response
    }) as typeof fetch
    await expect(fetchIdentity("https://example.test/model", {}, rawFetch)).rejects.toThrow("refused compressed response")
    expect(cancelled).toBe(true)
    expect(response.bodyUsed).toBe(true)
  })
})
