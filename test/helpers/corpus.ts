import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type Config, defaultConfig } from "../../src/config.ts"

export const FIXTURES = join(import.meta.dir, "..", "fixtures")

/** Default settings, but indexing the whole (test) home folder. */
export function homeConfig(): Config {
  return { ...defaultConfig(), roots: ["~"] }
}

/** Create a throwaway "home" folder with a realistic mix of files. */
export function makeCorpus(): { home: string; cleanup: () => void; write: (rel: string, data: string | Uint8Array) => string } {
  const home = mkdtempSync(join(process.env.ZSEARCH_TEST_TMP || tmpdir(), "zsearch-home-"))
  const write = (rel: string, data: string | Uint8Array) => {
    const p = join(home, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, data)
    return p
  }
  cpSync(join(FIXTURES, "docs"), join(home, "Documents"), { recursive: true })
  cpSync(join(FIXTURES, "poi"), join(home, "Documents", "old"), { recursive: true })
  write("notes/todo.md", "# Todo\n\n- renew passport before the trip to Lisbon\n- call the plumber about the leaking sink\n")
  write("notes/recipes/pancakes.txt", "Pancakes\nMix flour, eggs, milk and a pinch of salt.\nFry in butter until golden.\n")
  write("notes/journal-2024.md", "Went hiking in the Alps. The glacier was smaller than last year.\nClimate change is visible.\n")
  write(
    "code/app/src/server.ts",
    'import { serve } from "bun"\n\nexport function getUserName(id: number): string {\n  return `user_${id}`\n}\n\nconst PORT = 8080\nserve({ port: PORT, fetch: () => new Response("hello") })\n',
  )
  write("code/app/src/util/parse_config.py", "import json\n\ndef parse_config(path):\n    with open(path) as f:\n        return json.load(f)\n\nMAX_RETRIES = 42\n")
  write("code/app/README.md", "# App\n\nA tiny HTTP server. Run with `bun run src/server.ts`.\n")
  write("code/app/.gitignore", "dist/\n*.log\n")
  write("code/app/dist/bundle.js", "console.log('built output should be ignored')\n")
  write("code/app/debug.log", "ERROR something ignored\n")
  write("code/app/node_modules/leftpad/index.js", "module.exports = () => 'node_modules is skipped'\n")
  write(".config/secret.conf", "token = hidden-dotfile-content\n")
  write("Pictures/holiday-beach.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]))
  write("Downloads/archive.bin", new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256)))
  write("Downloads/unknown-text-file", "This file has no extension but contains the word zanzibar.\n")
  write("Music/song.mp3", new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]))
  const old = join(home, "notes", "journal-2024.md")
  utimesSync(old, new Date("2024-03-01"), new Date("2024-03-01"))
  return { home, write, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}
