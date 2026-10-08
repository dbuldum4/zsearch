#!/usr/bin/env bun
/** zsearch entry point. */
declare const ZSEARCH_COMPILED: boolean | undefined
export {}

// When running from source (not the compiled binary), JSX files need the Solid transform.
// The compiled binary is built with the plugin already applied.
if (typeof ZSEARCH_COMPILED === "undefined" || !ZSEARCH_COMPILED) {
  const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
  ensureSolidTransformPlugin()
}

const { main } = await import("./cli.ts")
const code = await main(process.argv.slice(2))
process.exit(code)
