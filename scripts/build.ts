#!/usr/bin/env bun
/**
 * Build standalone zsearch executables.
 *
 *   bun run build                      # host platform -> dist/zsearch
 *   bun run build --target=bun-darwin-arm64 --target=bun-linux-x64
 *   bun run build --all                # macOS + Linux, x64 + arm64
 *
 * Cross-compiling needs OpenTUI's native package for each target:
 *   bun install --os="*" --cpu="*"
 */
import solidPlugin from "@opentui/solid/bun-plugin"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const ENTRY = "src/main.ts"
// Workers are separate entry points so the compiled binary can start them.
const WORKERS = ["src/index/index-worker.ts", "src/index/extract-worker.ts", "src/index/write-worker.ts", "src/search/search-worker.ts"]
const ALL = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"]

const args = process.argv.slice(2)
let targets = args.filter((a) => a.startsWith("--target=")).map((a) => a.slice("--target=".length))
if (args.includes("--all")) targets = ALL
const host = `bun-${process.platform}-${process.arch}`
if (!targets.length) targets = [host]

mkdirSync(join(ROOT, "dist"), { recursive: true })
let failed = false
for (const target of targets) {
  const outfile = join(ROOT, "dist", target === host && targets.length === 1 ? "zsearch" : `zsearch-${target.replace(/^bun-/, "")}`)
  const libc = target.includes("musl") ? "musl" : "glibc"
  const started = performance.now()
  const result = await Bun.build({
    // All entry points live under src/, so the embedded layout mirrors src/ (see src/util/workers.ts).
    entrypoints: [ENTRY, ...WORKERS].map((p) => join(ROOT, p)),
    plugins: [solidPlugin],
    minify: true,
    sourcemap: "none",
    // The binary must behave the same in any folder: ignore bunfig.toml, .env, tsconfig and package.json there.
    compile: { target: target as Bun.Build.CompileTarget, outfile, autoloadBunfig: false, autoloadDotenv: false, autoloadTsconfig: false, autoloadPackageJson: false },
    define: {
      ZSEARCH_COMPILED: "true",
      "process.env.OPENTUI_LIBC": JSON.stringify(libc),
    },
  })
  if (!result.success) {
    failed = true
    console.error(`✗ ${target}`)
    for (const log of result.logs) console.error(log)
    continue
  }
  console.log(`✓ ${target} → ${outfile} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
}
process.exit(failed ? 1 : 0)
