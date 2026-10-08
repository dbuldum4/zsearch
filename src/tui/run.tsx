import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { openSync } from "node:fs"
import tty from "node:tty"
import type { Config } from "../config.ts"
import type { Mode } from "../search/query.ts"
import { App } from "./app.tsx"
import { realServices } from "./services.ts"

export interface RunOptions {
  config: Config
  query?: string
  mode?: Mode
  print?: boolean
}

/** Open the terminal directly when stdout is piped (e.g. `vim "$(zsearch -p)"`). */
function ttyStreams(): { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } {
  if (process.stdout.isTTY && process.stdin.isTTY) return {}
  try {
    const out = new tty.WriteStream(openSync("/dev/tty", "w"))
    const inp = process.stdin.isTTY ? process.stdin : new tty.ReadStream(openSync("/dev/tty", "r"))
    return { stdin: inp as NodeJS.ReadStream, stdout: out as unknown as NodeJS.WriteStream }
  } catch {
    return {}
  }
}

/** Run the interactive UI. Resolves with the chosen path in print mode, else null. */
export async function runTui(opts: RunOptions): Promise<string | null> {
  const services = realServices(opts.config)
  const streams = ttyStreams()
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    useMouse: true,
    autoFocus: false,
    ...streams,
  })
  let selection: string | null = null
  const closed = new Promise<void>((resolve) => renderer.once("destroy", () => resolve()))
  await render(
    () => (
      <App
        services={services}
        initialQuery={opts.query}
        initialMode={opts.mode}
        printMode={opts.print}
        onExit={(sel) => {
          selection = sel
          renderer.destroy()
        }}
      />
    ),
    renderer,
  )
  await closed
  services.search.close()
  await services.dispose?.()
  return selection
}
