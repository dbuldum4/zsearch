import { expect } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig, loadConfig, saveConfig } from "../../src/config.ts"
import { clearIndex, openDb } from "../../src/index/db.ts"
import { Indexer } from "../../src/index/indexer.ts"
import { SemanticIndexer } from "../../src/semantic/indexer.ts"
import { Embedder } from "../../src/semantic/helper.ts"
import { SearchEngine } from "../../src/search/engine.ts"

const dir = mkdtempSync(join(tmpdir(), "zsearch-meaning-"))
try {
  const root = join(dir, "docs")
  mkdirSync(root)
  process.env.ZSEARCH_HOME = join(dir, "data")
  const config = { ...defaultConfig(), roots: [root], indexLoad: 100, semantic: { enabled: true, images: false, code: true } }
  expect(config.defaultMode).toBe("semantic")
  saveConfig(config)
  expect(loadConfig().defaultMode).toBe("semantic")
  saveConfig({ ...config, defaultMode: "find", semantic: { ...config.semantic, enabled: false } })
  expect(loadConfig().defaultMode).toBe("semantic")
  const car = join(root, "garage.txt")
  writeFileSync(car, "My sedan needs new tyres before winter.")
  for (let i = 0; i < 32; i++) writeFileSync(join(root, `other${i}.txt`), `We cooked pancakes with milk and flour. Recipe number ${i}.`)
  writeFileSync(join(root, ".env"), "SECRET=car")
  writeFileSync(join(root, "keys.txt"), "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----")
  const tool = join(dir, "helper")
  writeFileSync(tool, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-embed.ts")}" "$@"\n`)
  chmodSync(tool, 0o755)
  const db = openDb(join(dir, "data", "index.db"))
  const index = async (inline: boolean) => {
    await new Indexer(db, config, { inProcess: inline }).run()
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'fts'").get()).toBeNull()
    expect(db.query("SELECT count(*) FROM vocab_chunks").values()[0]![0]).toBe(0)
    expect(db.query("SELECT count(*) FROM files WHERE in_fts <> 0").values()[0]![0]).toBe(0)
    expect(db.query("SELECT f.path FROM content c JOIN files f ON c.id = f.id WHERE f.name IN ('.env', 'keys.txt')").all()).toHaveLength(0)
    const r = await new SemanticIndexer(db, config, tool, { vectorVersion: 1, embedder: opts => new Embedder({ ...opts, tool, model: "fake" }) }).run()
    expect(r).toMatchObject({ status: "done" })
  }
  await index(false) // Exercise the real writer/extractor worker boundary.
  const engine = new SearchEngine(db, config)
  engine.embedQuery = async text => {
    const h = new Embedder({ tool, model: "fake" })
    try { return (await h.embedTexts([`task: search result | query: ${text}`])).vectors } finally { h.close() }
  }
  const result = await engine.search("automobile", "find")
  expect(result.error).toBeUndefined()
  expect(result.resolved).toBe("semantic")
  expect(result.strategy).toBe("meaning")
  expect(result.hits[0]?.path).toBe(car)
  expect(result.hits[0]?.lines[0]?.text).toContain("sedan")
  expect((await engine.search("automobile -sedan", "find")).hits.some(h => h.path === car)).toBe(false)
  engine.embedQuery = null
  expect((await engine.search("pancakes", "fuzzy")).hits).toHaveLength(0)
  engine.closeSemantic()
  renameSync(car, join(root, "moved.txt"))
  writeFileSync(join(root, "moved.txt"), "My automobile needs an oil change.")
  rmSync(join(root, "other0.txt"))
  await index(true)
  clearIndex(db)
  await index(false)
  process.env.ZSEARCH_MEANING_ONLY = "0"
  expect(() => openDb(join(dir, "data", "index.db"))).toThrow("different search profile")
  process.env.ZSEARCH_MEANING_ONLY = "1"
  db.close()
  saveConfig({ ...config, autoRefreshMinutes: 0, liveUpdates: false })
  const server = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/main.ts"), "serve"], { env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  server.stdin.write(JSON.stringify({ id: 9, type: "semanticRemove" }) + "\n")
  server.stdin.write(JSON.stringify({ id: 10, type: "config" }) + "\n")
  server.stdin.end()
  const [status, out, err] = await Promise.all([server.exited, new Response(server.stdout).text(), new Response(server.stderr).text()])
  expect({status,err}).toEqual({status:0,err:""})
  const replies = out.trim().split("\n").map(line=>JSON.parse(line))
  expect(replies.find(r=>r.id===9)).toMatchObject({type:"semantic",status:{enabled:false}})
  expect(replies.find(r=>r.id===10)?.config.defaultMode).toBe("semantic")
  console.log("meaning-only OK")
} finally { rmSync(dir, { recursive: true, force: true }) }
