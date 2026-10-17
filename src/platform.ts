import { spawn, spawnSync } from "node:child_process"
import { existsSync, accessSync, constants, statSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { release } from "node:os"
import { home, paths } from "./config.ts"

export const isMac = process.platform === "darwin"

/** Folder names skipped wherever they appear (build output, caches, VCS internals...). */
export const SKIP_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".bzr",
  "_darcs",
  "CVS",
  "node_modules",
  "bower_components",
  "jspm_packages",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".hypothesis",
  ".tox",
  ".nox",
  ".venv",
  "venv",
  ".eggs",
  ".gradle",
  ".terraform",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".parcel-cache",
  ".turbo",
  ".angular",
  ".dart_tool",
  ".pub-cache",
  ".stack-work",
  "elm-stuff",
  ".cache",
  ".Trash",
  ".Trashes",
  ".Spotlight-V100",
  ".fseventsd",
  ".DocumentRevisions-V100",
  ".TemporaryItems",
  "$RECYCLE.BIN",
  "System Volume Information",
  "lost+found",
  "DerivedData",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".cargo",
  ".rustup",
  ".m2",
  ".ivy2",
  ".sbt",
  ".conda",
  ".pyenv",
  ".nvm",
  ".bun",
  ".deno",
  ".gem",
  ".android",
  ".vagrant.d",
  ".docker",
])

/**
 * macOS packages (directories presented as files). They are indexed by name but
 * never descended into: an `.app` bundle can hold thousands of resources.
 */
export const PACKAGE_EXTS = new Set([
  "app",
  "framework",
  "bundle",
  "kext",
  "plugin",
  "appex",
  "xpc",
  "photoslibrary",
  "photolibrary",
  "musiclibrary",
  "tvlibrary",
  "imovielibrary",
  "fcpbundle",
  "logicx",
  "band",
  "xcarchive",
  "xcassets",
  "lproj",
  "dSYM",
  "mlmodelc",
  "pages",
  "numbers",
  "key",
  "rtfd",
  "sparsebundle",
  "vmwarevm",
  "pvm",
  "utm",
])

/** Absolute folders skipped entirely. */
export function systemExcludes(): string[] {
  const h = home()
  const p = paths()
  const common = [p.data]
  if (isMac) {
    return [
      ...common,
      "/System",
      "/Volumes",
      "/dev",
      "/cores",
      "/private/var/vm",
      "/private/var/folders",
      "/private/var/db",
      "/private/tmp",
      "/Library/Caches",
      "/.Spotlight-V100",
      "/.fseventsd",
      "/.vol",
      "/Network",
      "/nix/store",
      join(h, ".Trash"),
      join(h, "Library", "Caches"),
      join(h, "Library", "Containers"),
      join(h, "Library", "Group Containers"),
      join(h, "Library", "Developer"),
      join(h, "Library", "Logs"),
      join(h, "go", "pkg"),
    ]
  }
  return [
    ...common,
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/tmp",
    "/var/tmp",
    "/var/cache",
    "/var/lib/docker",
    "/var/lib/containers",
    "/var/lib/flatpak",
    "/var/lib/snapd",
    "/var/log/journal",
    "/snap",
    "/nix/store",
    "/lost+found",
    "/mnt",
    "/media",
    join(h, "snap"),
    join(h, ".local", "share", "Trash"),
    join(h, ".local", "share", "Steam"),
    join(h, ".steam"),
    join(h, ".var", "app"),
    join(h, "go", "pkg"),
  ]
}

/**
 * Folders where only selected children are walked. On macOS `~/Library` is mostly
 * app state, but iCloud Drive and cloud-storage providers live inside it.
 */
export function onlyChildren(): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>()
  if (isMac) m.set(join(home(), "Library"), new Set(["Mobile Documents", "CloudStorage"]))
  return m
}

/** Cloud-synced folders whose files may be online-only placeholders. */
export function cloudFolders(): string[] {
  const h = home()
  if (isMac) return [join(h, "Library", "Mobile Documents"), join(h, "Library", "CloudStorage")]
  return []
}

/** System folders that are indexed by name only when the whole disk is indexed. */
export function systemNamesOnly(): string[] {
  if (isMac) return ["/Applications", "/Library", "/usr", "/bin", "/sbin", "/opt", "/private", "/etc", "/var"]
  return ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/opt", "/etc", "/var", "/boot", "/srv"]
}

function which(cmd: string): string | null {
  if (!cmd) return null
  const candidates = cmd.includes("/") ? [resolve(cmd)] : (process.env.PATH ?? "").split(":").map((dir) => join(dir || ".", cmd))
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return resolve(path) } catch {}
  }
  return null
}

const whichCache = new Map<string, string | null>()
function findTool(cmd: string): string | null {
  if (!whichCache.has(cmd)) whichCache.set(cmd, which(cmd))
  return whichCache.get(cmd) ?? null
}

/** Open a path with the desktop's default application. Resolves with an error message on failure. */
export function openWithDefault(path: string): Promise<string | null> {
  const cmd = isMac ? "open" : findTool("xdg-open") ? "xdg-open" : findTool("gio") ? "gio" : null
  if (!cmd) return Promise.resolve("no opener found (install xdg-utils)")
  const args = cmd === "gio" ? ["open", path] : [path]
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" })
      child.on("error", (e) => resolve(e.message))
      child.on("spawn", () => {
        child.unref()
        resolve(null)
      })
    } catch (e) {
      resolve((e as Error).message)
    }
  })
}

/** Reveal a file in Finder / the file manager. */
export function revealInFileManager(path: string, isDir: boolean): Promise<string | null> {
  if (isMac) {
    return new Promise((resolve) => {
      const child = spawn("open", isDir ? [path] : ["-R", path], { detached: true, stdio: "ignore" })
      child.on("error", (e) => resolve(e.message))
      child.on("spawn", () => {
        child.unref()
        resolve(null)
      })
    })
  }
  return openWithDefault(isDir ? path : path.slice(0, path.lastIndexOf("/")) || "/")
}

/** Editor command line for a file at an optional line. */
export function editorCommand(editorSetting: string, file: string, line?: number): string[] {
  const editor = editorSetting || process.env.VISUAL || process.env.EDITOR || (findTool("nvim") ? "nvim" : findTool("vim") ? "vim" : "vi")
  const parts = editor.split(/\s+/).filter(Boolean)
  const executable = findTool(parts[0]!)
  if (!executable) throw new Error(`editor executable not found: ${parts[0]}`)
  const bin = executable.split("/").pop()!
  const interpreter = /^(?:ba|da|z|fi|tc|c|k)?sh$|^(?:bash|fish|python[0-9.]*|perl|ruby|node|bun|env|osascript)$/
  if (interpreter.test(bin) || interpreter.test(realpathSync(executable).split("/").pop()!)) throw new Error("choose an editor executable, not a command interpreter")
  parts[0] = executable
  if (line && line > 0) {
    if (/^(code|code-insiders|cursor|codium|windsurf)$/.test(bin)) return [...parts, "-g", `${file}:${line}`]
    if (/^(zed|subl|sublime_text|hx|helix|micro)$/.test(bin)) return [...parts, `${file}:${line}`]
    if (/^(n?vim?|lvim|vi|nano|emacs|emacsclient|mg|joe|ne|kak)$/.test(bin)) return [...parts, `+${line}`, file]
  }
  return [...parts, file]
}

/** Whether the editor runs inside the terminal (so the TUI must suspend while it runs). */
export function isTerminalEditor(cmd: string[]): boolean {
  const bin = cmd[0]!.split("/").pop()!
  return /^(n?vim?|vi|nano|emacs|mg|joe|ne|hx|helix|kak|micro|amp|ed|lvim)$/.test(bin) || (bin === "emacsclient" && cmd.includes("-t"))
}

/** Copy text to the system clipboard. Returns false if no clipboard tool is available. */
export function copyToClipboard(text: string): boolean {
  const candidates: string[][] = isMac
    ? [["pbcopy"]]
    : [
        ...(process.env.WAYLAND_DISPLAY ? [["wl-copy"]] : []),
        ["xclip", "-selection", "clipboard"],
        ["xsel", "--clipboard", "--input"],
      ]
  for (const c of candidates) {
    if (!findTool(c[0]!)) continue
    const r = spawnSync(c[0]!, c.slice(1), { input: text, timeout: 2000 })
    if (r.status === 0) return true
  }
  return false
}

/**
 * The OCR helper, `zsearch-ocr`: bundled next to the engine in the Mac app (Contents/Helpers),
 * or named by $ZSEARCH_OCR. It reads the text in images and in scanned PDF pages with macOS's
 * Vision framework. `ZSEARCH_OCR=0` turns it off.
 */
export function ocrToolPath(): string | null {
  const env = process.env.ZSEARCH_OCR
  if (env !== undefined) return env && env !== "0" && existsSync(env) ? env : null
  if (!isMac) return null
  const bundled = join(dirname(process.execPath), "zsearch-ocr")
  return existsSync(bundled) ? bundled : null
}

export function pdftotextPath(): string | null {
  if (/^(1|true|yes|on)$/i.test(process.env.ZSEARCH_NO_PDFTOTEXT ?? "")) return null
  return findTool("pdftotext")
}

/** Apple SpeechAnalyzer needs macOS 26+. The helper checks device/language support itself. */
export function transcriptionToolPath(): string | null {
  const env = process.env.ZSEARCH_TRANSCRIBE
  if (env !== undefined) return env && env !== "0" ? which(env) : null
  if (!isMac) return null
  // Darwin 25 is macOS 26. Older Macs keep their audio/video files searchable by name.
  if (Number(release().split(".")[0]) < 25) return null
  const bundled = join(dirname(process.execPath), "zsearch-transcribe")
  return existsSync(bundled) ? bundled : null
}
