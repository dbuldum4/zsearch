import type { InputRenderable, KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { type Config, home, resolvePath, tildify } from "../config.ts"
import { isMac } from "../platform.ts"
import { StyledLine } from "./line.tsx"
import { type Seg, truncate } from "./styled.ts"
import type { Theme } from "./theme.ts"

export interface SetupProps {
  config: Config
  theme: Theme
  firstRun: boolean
  width: number
  height: number
  /** `changed`: whether the index has to be rebuilt/updated. */
  onDone: (config: Config, changed: boolean) => void
  onCancel: () => void
}

type Scope = "home" | "disk" | "custom"

function scopeOf(roots: string[]): Scope {
  const r = roots.map(resolvePath)
  if (r.length === 1 && r[0] === home()) return "home"
  if (r.length === 1 && r[0] === "/") return "disk"
  return "custom"
}

const ITEMS = ["home", "disk", "custom", "content", "hidden", "gitignore", "semantic", "start", "cancel"] as const
type Item = (typeof ITEMS)[number]

export function Setup(props: SetupProps) {
  const [scope, setScope] = createSignal<Scope>(scopeOf(props.config.roots))
  const [custom, setCustom] = createSignal(scopeOf(props.config.roots) === "custom" ? props.config.roots.join(", ") : "~/Documents, ~/Desktop")
  const [content, setContent] = createSignal(props.config.content.enabled)
  const [hidden, setHidden] = createSignal(props.config.includeHidden)
  const [gitignore, setGitignore] = createSignal(props.config.respectGitignore)
  const [semantic, setSemantic] = createSignal(props.config.semantic.enabled)
  const [cursor, setCursor] = createSignal<number>(ITEMS.indexOf("start"))
  const [editing, setEditing] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let input: InputRenderable | undefined

  const t = () => props.theme
  const item = (): Item => ITEMS[cursor()]!

  const build = (): Config | null => {
    const next: Config = structuredClone(props.config)
    if (scope() === "home") next.roots = ["~"]
    else if (scope() === "disk") next.roots = ["/"]
    else {
      const roots = custom()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      if (!roots.length) {
        setError("Enter at least one folder")
        return null
      }
      next.roots = roots
    }
    next.content.enabled = content()
    next.includeHidden = hidden()
    next.respectGitignore = gitignore()
    next.semantic.enabled = semantic()
    return next
  }

  const finish = () => {
    const next = build()
    if (!next) return
    const before = props.config
    const changed =
      props.firstRun ||
      JSON.stringify(before.roots.map(resolvePath)) !== JSON.stringify(next.roots.map(resolvePath)) ||
      before.content.enabled !== next.content.enabled ||
      before.includeHidden !== next.includeHidden ||
      before.respectGitignore !== next.respectGitignore ||
      before.semantic.enabled !== next.semantic.enabled
    props.onDone(next, changed)
  }

  const activate = () => {
    switch (item()) {
      case "home":
      case "disk":
        setScope(item() as Scope)
        break
      case "custom":
        setScope("custom")
        setEditing(true)
        break
      case "content":
        setContent((v) => !v)
        break
      case "hidden":
        setHidden((v) => !v)
        break
      case "gitignore":
        setGitignore((v) => !v)
        break
      case "semantic":
        setSemantic((v) => !v)
        break
      case "start":
        finish()
        break
      case "cancel":
        props.onCancel()
        break
    }
  }

  useKeyboard((key: KeyEvent) => {
    const k = key.name
    if (editing()) {
      if (k === "return" || k === "enter" || k === "escape" || k === "tab") {
        key.preventDefault()
        setEditing(false)
        if (input) setCustom(input.value)
      }
      return
    }
    key.preventDefault()
    if (key.ctrl && k === "c") return props.onCancel()
    if (k === "escape") return props.onCancel()
    if (k === "up" || (key.shift && k === "tab") || (key.ctrl && k === "p") || k === "k") setCursor((c) => (c + ITEMS.length - 1) % ITEMS.length)
    else if (k === "down" || k === "tab" || (key.ctrl && k === "n") || k === "j") setCursor((c) => (c + 1) % ITEMS.length)
    else if (k === "space") activate()
    else if (k === "return" || k === "enter") {
      // Enter on an option toggles it; enter on a button presses it. "s" starts right away.
      activate()
    } else if (k === "s" && !key.ctrl) finish()
    setError(null)
  })

  const w = () => Math.min(78, props.width - 2)
  const h = home()

  const line = (it: Item, segs: Seg[]): Seg[] => {
    const active = ITEMS[cursor()] === it
    return [{ text: active ? " ❯ " : "   ", fg: t().accent, bold: true }, ...segs.map((s) => (active ? { ...s, bold: s.bold ?? true } : s))]
  }
  const radio = (it: Scope, label: string, detail: string): Seg[] =>
    line(it, [
      { text: scope() === it ? "(•) " : "( ) ", fg: scope() === it ? t().accent : t().subtle },
      { text: label.padEnd(16), fg: t().text },
      { text: detail, fg: t().subtle, bold: false },
    ])
  const check = (it: Item, on: boolean, label: string, detail: string): Seg[] =>
    line(it, [
      { text: on ? "[x] " : "[ ] ", fg: on ? t().ok : t().subtle },
      { text: label, fg: t().text },
      { text: detail ? `  ${detail}` : "", fg: t().subtle, bold: false },
    ])
  const button = (it: Item, label: string, primary: boolean): Seg[] => {
    const active = ITEMS[cursor()] === it
    return [{ text: `  ${label}  `, fg: active ? t().accentText : primary ? t().accent : t().muted, bg: active ? t().accent : undefined, bold: true }]
  }

  const rows = createMemo((): (Seg[] | "input")[] => {
    const out: (Seg[] | "input")[] = []
    out.push([{ text: "  Fast search for everything in your files: names, text inside documents,", fg: t().muted }])
    out.push([{ text: "  code, PDFs, Office files — with fuzzy, exact, regex and semantic modes.", fg: t().muted }])
    out.push([])
    out.push([{ text: "  What should zsearch index?", fg: t().text, bold: true }])
    out.push(radio("home", "Home folder", tildify(h) === "~" ? h : h))
    out.push(radio("disk", "Entire disk", isMac ? "/  (grant Full Disk Access for protected folders)" : "/  (system folders: names only)"))
    out.push(radio("custom", "Custom folders", scope() === "custom" && !editing() ? truncate(custom(), w() - 30) : "comma-separated, e.g. ~/Documents, ~/code"))
    if (editing()) out.push("input")
    out.push([])
    out.push([{ text: "  Options", fg: t().text, bold: true }])
    out.push(check("content", content(), "Search inside files", "PDF, Word, Excel, PowerPoint, code, text…"))
    out.push(check("hidden", hidden(), "Include hidden files and folders", "dotfiles like ~/.config"))
    out.push(check("gitignore", gitignore(), "Skip files ignored by .gitignore", "build output, dependencies"))
    out.push(check("semantic", semantic(), "Semantic search", "find by meaning; downloads a ~30 MB model once"))
    out.push([])
    out.push([{ text: "    " }, ...button("start", props.firstRun ? "Start indexing" : "Save", true), { text: "   " }, ...button("cancel", props.firstRun ? "Quit" : "Cancel", false)])
    out.push([])
    const err = error()
    if (err) out.push([{ text: `  ${err}`, fg: t().error }])
    out.push([{ text: "  ↑↓ move · space toggle · enter select · s save · esc " + (props.firstRun ? "quit" : "cancel"), fg: t().subtle }])
    return out
  })

  return (
    <box width={props.width} height={props.height} flexDirection="column" alignItems="center" justifyContent="center">
      <box
        width={w()}
        height={Math.min(props.height, rows().length + 2)}
        border
        borderStyle="rounded"
        borderColor={t().borderFocus}
        title={props.firstRun ? " Welcome to zsearch " : " zsearch settings "}
        titleColor={t().accent}
        flexDirection="column"
        backgroundColor={props.firstRun ? undefined : t().panel}
      >
        <For each={rows()}>
          {(row) => (
            <Show
              when={row !== "input"}
              fallback={
                <box flexDirection="row" height={1} paddingLeft={7}>
                  <input
                    ref={(r: InputRenderable) => (input = r)}
                    value={custom()}
                    focused={editing()}
                    width={w() - 10}
                    textColor={t().text}
                    cursorColor={t().accent}
                    backgroundColor={t().selection}
                    focusedBackgroundColor={t().selection}
                    onInput={(v: string) => setCustom(v)}
                  />
                </box>
              }
            >
              <StyledLine segs={row as Seg[]} width={w() - 2} />
            </Show>
          )}
        </For>
      </box>
    </box>
  )
}
