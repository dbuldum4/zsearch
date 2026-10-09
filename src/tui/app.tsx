import type { BoxRenderable, InputRenderable, KeyEvent, MouseEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { type Config, tildify } from "../config.ts"
import type { IndexProgress } from "../index/indexer.ts"
import type { StatsReply } from "../search/client.ts"
import type { Preview, SearchHit, SearchResponse } from "../search/engine.ts"
import { MODES, type Mode } from "../search/query.ts"
import { formatAge, formatBytes, formatCount, formatDuration } from "../util/text.ts"
import { clampScroll, previewLayout, type Row, resultRows } from "./layout.ts"
import type { IndexHandle, Services } from "./services.ts"
import { Setup } from "./setup.tsx"
import { StyledLine } from "./line.tsx"
import { fitSegs, type Seg, segsWidth, truncate } from "./styled.ts"
import { DARK, LIGHT, type Theme } from "./theme.ts"

export interface AppProps {
  services: Services
  /** Initial query (from the command line). */
  initialQuery?: string
  initialMode?: Mode
  /** Print the chosen path and exit instead of opening it. */
  printMode?: boolean
  onExit?: (selection: string | null) => void
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const MODE_LABEL: Record<Mode, string> = { auto: "auto", fuzzy: "fuzzy", exact: "exact", regex: "regex" }

function RowText(props: { row: Row; width: number }) {
  return <StyledLine segs={props.row.segs} width={props.width} bg={props.row.bg} />
}

export function App(props: AppProps) {
  const renderer = useRenderer()
  const dims = useTerminalDimensions()
  const svc = props.services

  const [config, setConfig] = createSignal<Config>(svc.config)
  const [theme, setTheme] = createSignal<Theme>(renderer.themeMode === "light" ? LIGHT : DARK)
  const [screen, setScreen] = createSignal<"setup" | "search">(svc.firstRun ? "setup" : "search")
  const [overlay, setOverlay] = createSignal<null | "help" | "settings">(null)
  const [query, setQuery] = createSignal(props.initialQuery ?? "")
  const [mode, setMode] = createSignal<Mode>(props.initialMode ?? svc.config.defaultMode)
  const [response, setResponse] = createSignal<SearchResponse | null>(null)
  const [searching, setSearching] = createSignal(false)
  const [selected, setSelected] = createSignal(0)
  const [top, setTop] = createSignal(0)
  const [preview, setPreview] = createSignal<Preview | null>(null)
  const [previewTop, setPreviewTop] = createSignal(0)
  const [showPreview, setShowPreview] = createSignal(svc.config.preview)
  const [progress, setProgress] = createSignal<IndexProgress | null>(null)
  const [indexing, setIndexing] = createSignal(false)
  const [stats, setStats] = createSignal<StatsReply | null>(null)
  const [toast, setToast] = createSignal<{ text: string; kind: "info" | "ok" | "warn" | "error" } | null>(null)
  const [tick, setTick] = createSignal(0)
  let input: InputRenderable | undefined
  let indexHandle: IndexHandle | null = null
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let previewTimer: ReturnType<typeof setTimeout> | undefined
  let liveTimer: ReturnType<typeof setTimeout> | undefined
  let lastLiveSearch = 0
  let exiting = false

  const notify = (text: string, kind: "info" | "ok" | "warn" | "error" = "info", ms = 4000) => {
    setToast({ text, kind })
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => setToast(null), ms)
  }

  renderer.on("theme_mode", (m: "dark" | "light") => setTheme(m === "light" ? LIGHT : DARK))

  /* --------------------------------------------------------- geometry -- */
  const cols = () => dims().width
  const bodyHeight = () => Math.max(3, dims().height - 3 /* search box */ - 1 /* mode bar */ - 2 /* status + footer */)
  const previewVisible = () => showPreview() && cols() >= 90
  const listWidth = () => (previewVisible() ? Math.floor(cols() * 0.5) : cols())
  const previewWidth = () => cols() - listWidth() - 1
  const hits = createMemo<SearchHit[]>(() => response()?.hits ?? [])
  const current = () => hits()[Math.min(selected(), hits().length - 1)] ?? null

  /* ----------------------------------------------------------- search -- */
  let searchSeq = 0
  let lastMove = 0
  const runSearch = async (keepSelection = false) => {
    const q = query()
    const m = mode()
    const seq = ++searchSeq
    const issued = Date.now()
    setSearching(true)
    const res = await svc.search.search(q, m, 200)
    if (seq !== searchSeq || !res) return
    setSearching(false)
    // Keep the highlighted file if the user moved to it while this search was running.
    const prevId = current()?.id
    if (lastMove > issued) keepSelection = true
    // Update results and selection together so nothing observes a selection past the end.
    batch(() => {
      setResponse(res)
      if (keepSelection && prevId !== undefined) {
        const idx = res.hits.findIndex((h) => h.id === prevId)
        setSelected(idx >= 0 ? idx : Math.min(selected(), Math.max(0, res.hits.length - 1)))
      } else {
        setSelected(0)
        setTop(0)
      }
    })
  }
  const scheduleSearch = (delay = 25) => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void runSearch(), delay)
  }

  createEffect(
    on([query, mode], () => {
      if (screen() === "search") scheduleSearch()
    }),
  )

  // Live results while indexing: re-run the query at most once a second.
  const liveRefresh = () => {
    const now = Date.now()
    const wait = Math.max(0, 1000 - (now - lastLiveSearch))
    clearTimeout(liveTimer)
    liveTimer = setTimeout(() => {
      lastLiveSearch = Date.now()
      void runSearch(true)
    }, wait)
  }
  svc.search.onRefreshed = (_files, changed) => {
    if (changed) liveRefresh()
  }
  svc.search.onRestart = (reason) => notify(reason, "warn", 6000)

  /* ---------------------------------------------------------- preview -- */
  createEffect(
    on([current, previewVisible, query, mode], () => {
      clearTimeout(previewTimer)
      const h = current()
      if (!h || !previewVisible()) {
        if (!h) setPreview(null)
        return
      }
      const focus = h.lines[0]?.line
      previewTimer = setTimeout(async () => {
        const p = await svc.search.preview(h.id, query(), mode(), focus)
        if (!p || current()?.id !== h.id) return
        setPreview(p)
        const lay = previewLayout(p, previewWidth(), theme(), wrapPreview(p))
        setPreviewTop(Math.max(0, lay.focusRow - Math.floor(previewBodyHeight() / 4)))
      }, 30)
    }),
  )
  const wrapPreview = (p: Preview) => !["code", "data", "web"].includes(p.kind)
  const previewBodyHeight = () => bodyHeight() - 3

  /* --------------------------------------------------------- indexing -- */
  const refreshStats = async () => {
    const s = await svc.search.stats()
    if (s) setStats(s)
  }

  const startIndex = (reason: "manual" | "auto" | "setup" = "manual") => {
    if (indexing()) {
      notify("Indexing is already running")
      return
    }
    const other = svc.indexLockedBy()
    if (other !== null && other !== process.pid) {
      notify(`Another zsearch process (pid ${other}) is updating the index`, "warn")
      return
    }
    setIndexing(true)
    setProgress(null)
    const handle = svc.startIndex(config(), {
      onProgress: (p) => setProgress(p),
      onCommit: () => svc.search.refresh(),
    })
    indexHandle = handle
    void handle.done.then((outcome) => {
      indexHandle = null
      setIndexing(false)
      svc.search.refresh(true)
      void refreshStats()
      liveRefresh()
      if (outcome.status === "done") {
        const p = outcome.progress
        const changed = p.added + p.updated + p.removed
        if (reason !== "auto" || changed > 0)
          notify(
            `Index ready · ${formatCount(p.scanned)} items scanned${changed ? ` · ${formatCount(p.added)} new, ${formatCount(p.updated)} changed, ${formatCount(p.removed)} removed` : ""} · ${formatDuration(p.elapsedMs)}`,
            "ok",
            6000,
          )
      } else if (outcome.status === "cancelled") notify("Indexing cancelled", "warn")
      else if (outcome.status === "locked") notify("Another zsearch process is updating the index", "warn")
      else if (outcome.status === "error") notify(`Indexing failed: ${outcome.progress.error ?? "unknown error"}`, "error", 10_000)
      else if (outcome.status === "fatal") notify(`Indexing failed: ${outcome.error}`, "error", 10_000)
    })
  }

  onMount(() => {
    const spin = setInterval(() => {
      if (indexing() || searching()) setTick((t) => t + 1)
    }, 100)
    onCleanup(() => clearInterval(spin))
    void refreshStats().then(() => {
      if (screen() !== "search") return
      const s = stats()?.stats
      const maxAge = config().autoRefreshMinutes * 60_000
      if (!s || s.lastIndexedAt === null) startIndex("setup")
      else if (maxAge > 0 && Date.now() - s.lastIndexedAt > maxAge) startIndex("auto")
    })
    if (screen() === "search") scheduleSearch(0)
  })

  onCleanup(() => {
    indexHandle?.cancel()
    clearTimeout(searchTimer)
    clearTimeout(previewTimer)
    clearTimeout(liveTimer)
    clearTimeout(toastTimer)
  })

  /* ---------------------------------------------------------- actions -- */
  const quit = (selection: string | null = null) => {
    if (exiting) return
    exiting = true
    indexHandle?.cancel()
    props.onExit?.(selection)
  }

  const openSelected = async () => {
    const h = current()
    if (!h) return
    svc.search.opened(h.path)
    if (props.printMode) return quit(h.path)
    const err = await svc.open(h.path)
    if (err) notify(`Could not open: ${err}`, "error")
    else notify(`Opened ${tildify(h.path)}`, "ok", 2500)
  }

  const editSelected = async () => {
    const h = current()
    if (!h) return
    if (h.isDir) return revealSelected()
    svc.search.opened(h.path)
    const line = h.lines[0]?.line
    const err = await svc.edit(
      h.path,
      ["pdf", "doc", "sheet", "slides", "ebook"].includes(h.kind) ? undefined : line,
      async () => {
        await renderer.suspend()
      },
      async () => {
        await renderer.resume()
      },
    )
    if (err) notify(`Editor failed: ${err}`, "error")
  }

  const revealSelected = async () => {
    const h = current()
    if (!h) return
    const err = await svc.reveal(h.path, h.isDir)
    if (err) notify(`Could not reveal: ${err}`, "error")
  }

  const copySelected = async () => {
    const h = current()
    if (!h) return
    const where = await svc.copy(h.path, renderer)
    if (where === "host") notify(`Copied ${tildify(h.path)}`, "ok", 2500)
    else if (where === "terminal") notify(`Copied ${tildify(h.path)} (through the terminal)`, "ok", 2500)
    else notify("Could not reach a clipboard (install wl-clipboard, xclip or xsel)", "warn")
  }

  const move = (delta: number) => {
    const n = hits().length
    if (!n) return
    const next = Math.max(0, Math.min(n - 1, selected() + delta))
    lastMove = Date.now()
    setSelected(next)
    setTop(clampScroll(hits(), next, top(), bodyHeight()))
  }

  /* ------------------------------------------------------------ mouse -- */
  let listBox: BoxRenderable | undefined
  let lastClick = { idx: -1, at: 0 }
  const onListMouseDown = (e: MouseEvent) => {
    if (!listBox || e.button !== 0) return
    const row = listRows()[e.y - listBox.screenY]
    if (!row || row.hit < 0) return
    const now = Date.now()
    lastMove = now
    setSelected(row.hit)
    if (lastClick.idx === row.hit && now - lastClick.at < 400) void openSelected()
    lastClick = { idx: row.hit, at: now }
  }
  const onListScroll = (e: MouseEvent) => {
    if (e.scroll?.direction === "up") move(-3)
    else if (e.scroll?.direction === "down") move(3)
  }
  const onPreviewScroll = (e: MouseEvent) => {
    if (e.scroll?.direction === "up") scrollPreview(-3)
    else if (e.scroll?.direction === "down") scrollPreview(3)
  }

  const cycleMode = (dir: 1 | -1) => {
    const i = MODES.indexOf(mode())
    setMode(MODES[(i + dir + MODES.length) % MODES.length]!)
  }

  const scrollPreview = (delta: number) => {
    const p = preview()
    if (!p) return
    const total = previewLayout(p, previewWidth(), theme(), wrapPreview(p)).body.length
    setPreviewTop((t) => Math.max(0, Math.min(Math.max(0, total - previewBodyHeight()), t + delta)))
  }

  const jumpMatch = (dir: 1 | -1) => {
    const p = preview()
    const h = current()
    if (!p || !h || !p.matchLines.length) return
    const sorted = [...new Set(p.matchLines)].sort((a, b) => a - b)
    const cur = p.focusLine
    const next = dir > 0 ? (sorted.find((l) => l > cur) ?? sorted[0]!) : ([...sorted].reverse().find((l) => l < cur) ?? sorted[sorted.length - 1]!)
    void svc.search.preview(h.id, query(), mode(), next).then((np) => {
      if (!np || current()?.id !== h.id) return
      setPreview(np)
      const lay = previewLayout(np, previewWidth(), theme(), wrapPreview(np))
      setPreviewTop(Math.max(0, lay.focusRow - Math.floor(previewBodyHeight() / 4)))
    })
  }

  const applySettings = (next: Config, reindex: boolean) => {
    setConfig(next)
    svc.saveConfig(next)
    svc.search.setConfig(next)
    setOverlay(null)
    setScreen("search")
    scheduleSearch(0)
    if (reindex) {
      if (indexing()) {
        indexHandle?.cancel()
        setTimeout(() => startIndex("setup"), 300)
      } else startIndex("setup")
    }
    void refreshStats()
  }

  useKeyboard((key: KeyEvent) => {
    if (screen() === "setup" || overlay() === "settings") return // Setup handles its own keys
    const k = key.name
    if (key.ctrl && k === "c") {
      key.preventDefault()
      return quit()
    }
    if (overlay() === "help") {
      key.preventDefault()
      if (k === "escape" || k === "q" || k === "f1" || k === "return" || (key.ctrl && k === "/")) setOverlay(null)
      return
    }
    const handled = (fn: () => unknown) => {
      key.preventDefault()
      void fn()
    }
    if (k === "escape") return handled(() => (query() ? (input && (input.value = ""), setQuery("")) : quit()))
    if (k === "return" || k === "enter") return handled(openSelected)
    if (k === "up" && key.shift) return handled(() => scrollPreview(-1))
    if (k === "down" && key.shift) return handled(() => scrollPreview(1))
    if (k === "up" || (key.ctrl && (k === "p" || k === "k"))) return handled(() => move(-1))
    if (k === "down" || (key.ctrl && (k === "n" || k === "j"))) return handled(() => move(1))
    if (k === "pageup") return handled(() => move(-Math.max(1, Math.floor(bodyHeight() / 2))))
    if (k === "pagedown") return handled(() => move(Math.max(1, Math.floor(bodyHeight() / 2))))
    if (k === "tab") return handled(() => cycleMode(key.shift ? -1 : 1))
    if (k === "f1" || (key.ctrl && (k === "/" || k === "_"))) return handled(() => setOverlay("help"))
    if (key.ctrl) {
      switch (k) {
        case "e":
          return handled(editSelected)
        case "o":
          return handled(revealSelected)
        case "y":
          return handled(copySelected)
        case "r":
          return handled(() => startIndex("manual"))
        case "x":
          return handled(() => (indexHandle ? (indexHandle.cancel(), notify("Stopping indexer…")) : notify("Indexer is not running")))
        case "t":
          return handled(() => setShowPreview((v) => !v))
        case "s":
          return handled(() => setOverlay("settings"))
        case "d":
          return handled(() => scrollPreview(Math.floor(previewBodyHeight() / 2)))
        case "u":
          return handled(() => scrollPreview(-Math.floor(previewBodyHeight() / 2)))
        case "f":
          return handled(() => jumpMatch(1))
        case "b":
          return handled(() => jumpMatch(-1))
      }
    }
    if (key.meta && (k === "1" || k === "2" || k === "3" || k === "4")) return handled(() => setMode(MODES[Number(k) - 1]!))
  })

  /* ------------------------------------------------------------- view -- */
  const t = theme

  const searchBox = () => {
    const r = response()
    const segs: Seg[] = []
    if (searching() && query()) segs.push({ text: `${SPINNER[tick() % SPINNER.length]} `, fg: t().accent })
    if (r && !r.error) {
      segs.push({ text: `${formatCount(r.total)} result${r.total === 1 ? "" : "s"}`, fg: t().muted })
      segs.push({ text: ` · ${r.elapsedMs < 10 ? r.elapsedMs.toFixed(1) : Math.round(r.elapsedMs)}ms`, fg: t().subtle })
      if (r.partial) segs.push({ text: " · partial", fg: t().warn })
    }
    return segs
  }

  const modeBar = createMemo(() => {
    const segs: Seg[] = [{ text: " " }]
    for (const m of MODES) {
      const active = m === mode()
      segs.push(active ? { text: ` ${MODE_LABEL[m].toUpperCase()} `, fg: t().accentText, bg: t().accent, bold: true } : { text: ` ${MODE_LABEL[m]} `, fg: t().subtle })
      segs.push({ text: " " })
    }
    const r = response()
    const right = r?.error ? r.error : (r?.notice ?? r?.strategy ?? "")
    const left = segs.reduce((n, s) => n + Bun.stringWidth(s.text), 0)
    const room = cols() - left - 1
    if (room > 4 && right) {
      const text = truncate(right, room)
      segs.push({ text: " ".repeat(Math.max(0, room - Bun.stringWidth(text))) })
      segs.push({ text, fg: r?.error ? t().error : r?.notice ? t().warn : t().subtle, italic: !r?.error })
    }
    return segs
  })

  const listRows = createMemo(() => resultRows(hits(), selected(), clampScroll(hits(), selected(), top(), bodyHeight()), listWidth(), bodyHeight(), t()))

  const emptyMessage = createMemo((): Seg[][] => {
    const r = response()
    const s = stats()?.stats
    if (r?.error) return [[{ text: `  ${r.error}`, fg: t().error }]]
    if (!r) return [[{ text: "  Searching…", fg: t().subtle }]]
    if (hits().length) return []
    if (s && s.files === 0 && !indexing()) return [[{ text: "  The index is empty. Press Ctrl-R to index, or Ctrl-S to choose folders.", fg: t().warn }]]
    if (!query()) return [[{ text: indexing() ? "  Indexing… results appear as files are found." : "  Start typing to search.", fg: t().subtle }]]
    const lines: Seg[][] = [[{ text: `  No matches for “${query()}”`, fg: t().muted }], []]
    if (mode() !== "auto") lines.push([{ text: "  Tip: press Tab to try another mode (auto, fuzzy, exact, regex).", fg: t().subtle }])
    if (indexing()) lines.push([{ text: "  Still indexing — more results may appear shortly.", fg: t().subtle }])
    return lines
  })

  const previewRows = createMemo(() => {
    const p = preview()
    // Never show a preview that belongs to a different result than the highlighted one.
    if (!p || !previewVisible() || p.id !== current()?.id) return null
    const lay = previewLayout(p, previewWidth(), t(), wrapPreview(p))
    const h = previewBodyHeight()
    const topRow = Math.min(previewTop(), Math.max(0, lay.body.length - h))
    return { header: lay.header, body: lay.body.slice(topRow, topRow + h) }
  })

  const statusLine = createMemo((): Seg[] => {
    tick()
    const p = progress()
    const tt = toast()
    if (indexing()) {
      const spin = SPINNER[tick() % SPINNER.length]!
      const segs: Seg[] = [{ text: ` ${spin} `, fg: t().accent }]
      if (!p || p.phase === "starting" || p.phase === "scan") {
        segs.push({ text: "Scanning folders… ", fg: t().text, bold: true }, { text: `${formatCount(p?.scanned ?? 0)} items found`, fg: t().muted })
        if (p?.current) segs.push({ text: `  ${tildify(p.current)}`, fg: t().subtle })
      } else if (p.phase === "content") {
        const pct = p.contentTotal ? p.contentDone / p.contentTotal : 1
        const eta = pct > 0.02 && p.contentDone > 0 ? ((p.elapsedMs / Math.max(1, p.contentDone)) * (p.contentTotal - p.contentDone)) : 0
        segs.push({ text: "Reading contents ", fg: t().text, bold: true }, ...bar(pct, 18, t()), {
          text: ` ${formatCount(p.contentDone)}/${formatCount(p.contentTotal)} · ${formatBytes(p.contentBytes)} text${eta ? ` · ~${formatDuration(eta)} left` : ""}`,
          fg: t().muted,
        })
        if (p.current) segs.push({ text: `  ${tildify(p.current)}`, fg: t().subtle })
      } else segs.push({ text: "Finishing up…", fg: t().muted })
      return segs
    }
    if (tt) {
      const color = tt.kind === "ok" ? t().ok : tt.kind === "warn" ? t().warn : tt.kind === "error" ? t().error : t().text
      return [{ text: ` ${tt.kind === "ok" ? "✓" : tt.kind === "error" ? "✗" : tt.kind === "warn" ? "!" : "•"} ${tt.text}`, fg: color }]
    }
    const s = stats()
    if (!s) return [{ text: " Loading index…", fg: t().subtle }]
    const st = s.stats
    const parts = [
      `${formatCount(st.files)} files`,
      `${formatCount(st.folders)} folders`,
      `${formatCount(st.withContent)} with text (${formatBytes(st.contentBytes)})`,
      st.lastIndexedAt ? `indexed ${formatAge(st.lastIndexedAt)}` : "not indexed yet",
    ]
    return [{ text: ` ${parts.join(" · ")}`, fg: t().subtle }]
  })

  const footer = createMemo((): Seg[] => {
    const keys: [string, string][] = [
      ["↵", props.printMode ? "select" : "open"],
      ["^E", "edit"],
      ["^O", "reveal"],
      ["^Y", "copy"],
      ["⇥", "mode"],
      ["^T", "preview"],
      ["^R", "reindex"],
      ["^S", "settings"],
      ["F1", "help"],
      ["esc", "quit"],
    ]
    const segs: Seg[] = [{ text: " " }]
    for (const [k, label] of keys) segs.push({ text: k, fg: t().accent, bold: true }, { text: ` ${label}  `, fg: t().subtle })
    return segs
  })

  return (
    <box flexDirection="column" width={cols()} height={dims().height}>
      <Show
        when={screen() === "search"}
        fallback={
          <Setup
            config={config()}
            theme={t()}
            firstRun
            width={cols()}
            height={dims().height}
            onDone={(c) => applySettings(c, true)}
            onCancel={() => quit()}
          />
        }
      >
        <box border borderStyle="rounded" borderColor={overlay() ? t().border : t().borderFocus} height={3} flexDirection="row" paddingLeft={1} paddingRight={1} title=" zsearch " titleColor={t().accent}>
          <StyledLine segs={[{ text: "❯ ", fg: t().accent, bold: true }]} width={2} />
          <input
            ref={(r: InputRenderable) => (input = r)}
            value={props.initialQuery ?? ""}
            focused={!overlay()}
            flexGrow={1}
            placeholder="Search names and contents · try ext:pdf, in:~/Documents, /regex/, ?question"
            textColor={t().text}
            cursorColor={t().accent}
            onInput={(v: string) => setQuery(v)}
          />
          <StyledLine segs={searchBox()} />
        </box>
        <RowText row={{ key: "modes", segs: modeBar(), hit: -1 }} width={cols()} />
        <box flexDirection="row" height={bodyHeight()}>
          <box ref={(r: BoxRenderable) => (listBox = r)} flexDirection="column" width={listWidth()} height={bodyHeight()} onMouseDown={onListMouseDown} onMouseScroll={onListScroll}>
            <Show when={hits().length} fallback={<For each={emptyMessage()}>{(segs) => <StyledLine segs={segs} width={listWidth()} />}</For>}>
              <For each={listRows()}>{(row) => <RowText row={row} width={listWidth()} />}</For>
            </Show>
          </box>
          <Show when={previewVisible()}>
            <box width={1} height={bodyHeight()} flexDirection="column">
              <For each={Array.from({ length: bodyHeight() }, (_, i) => i)}>{() => <StyledLine segs={[{ text: "│", fg: t().faint }]} width={1} />}</For>
            </box>
            <box flexDirection="column" width={previewWidth()} height={bodyHeight()} onMouseScroll={onPreviewScroll}>
              <Show when={previewRows()} fallback={<StyledLine segs={[{ text: hits().length ? "" : " No file selected", fg: t().subtle }]} width={previewWidth()} />}>
                <For each={previewRows()?.header ?? []}>{(row) => <RowText row={row} width={previewWidth()} />}</For>
                <For each={previewRows()?.body ?? []}>{(row) => <RowText row={row} width={previewWidth()} />}</For>
              </Show>
            </box>
          </Show>
        </box>
        <RowText row={{ key: "status", segs: statusLine(), hit: -1 }} width={cols()} />
        <RowText row={{ key: "footer", segs: footer(), hit: -1 }} width={cols()} />
        <Show when={overlay() === "help"}>
          <Help theme={t()} width={cols()} height={dims().height} />
        </Show>
        <Show when={overlay() === "settings"}>
          <box position="absolute" left={0} top={0} width={cols()} height={dims().height} zIndex={10}>
            <Setup
              config={config()}
              theme={t()}
              firstRun={false}
              width={cols()}
              height={dims().height}
              onDone={(c, changed) => applySettings(c, changed)}
              onCancel={() => setOverlay(null)}
            />
          </box>
        </Show>
      </Show>
    </box>
  )
}

function bar(pct: number, w: number, t: Theme): Seg[] {
  const filled = Math.round(Math.max(0, Math.min(1, pct)) * w)
  return [
    { text: "█".repeat(filled), fg: t.accent },
    { text: "░".repeat(w - filled), fg: t.faint },
    { text: ` ${Math.floor(pct * 100)}%`, fg: t.text },
  ]
}

const HELP: [string, [string, string][]][] = [
  [
    "Keys",
    [
      ["↑ ↓  ^P ^N  ^K ^J", "move selection"],
      ["PgUp PgDn", "page through results"],
      ["Enter", "open with the default app"],
      ["^E", "open in your editor at the match"],
      ["^O", "reveal in the file manager"],
      ["^Y", "copy the path"],
      ["Tab / Shift-Tab, Alt-1…4", "switch mode"],
      ["^T", "toggle preview"],
      ["Shift-↑↓  ^D ^U", "scroll preview"],
      ["^F ^B", "next / previous match in preview"],
      ["^R  /  ^X", "update the index  /  stop indexing"],
      ["^S", "settings: folders, hidden files"],
      ["Esc", "clear the query, or quit"],
    ],
  ],
  [
    "Modes",
    [
      ["auto", "names + text; regex if it looks like one"],
      ["fuzzy", "fzf-style name matching, forgives typos"],
      ["exact", "literal text, smart case"],
      ["regex", "regular expressions over contents"],
    ],
  ],
  [
    "Query syntax",
    [
      ["ext:pdf,docx  type:doc", "extension / kind (doc, sheet, slides, code…)"],
      ["in:~/Documents  path:2024", "inside a folder / path contains"],
      ["size:>5mb  mtime:<7d", "size / age (also after:2024-01-01)"],
      ['"exact phrase"  !word', "phrase / exclude a word"],
      ["/regex/  re:…  f:…", "force regex / fuzzy"],
      ["'exact ^prefix suffix$", "fzf operators in fuzzy name matching"],
    ],
  ],
]

function helpSection(title: string, items: [string, string][], t: Theme): Seg[][] {
  const keyWidth = Math.max(...items.map(([k]) => Bun.stringWidth(k))) + 2
  const out: Seg[][] = [[{ text: ` ${title}`, fg: t.accent, bold: true }]]
  for (const [k, v] of items) out.push([{ text: `   ${k.padEnd(keyWidth)}`, fg: t.text, bold: true }, { text: v, fg: t.muted }])
  return out
}

function Help(props: { theme: Theme; width: number; height: number }) {
  // Two columns when there is room: keys on the left, modes and syntax on the right.
  const twoCol = () => props.width >= 140
  const w = () => (twoCol() ? Math.min(150, props.width - 4) : Math.min(90, props.width - 4))
  const rows = createMemo(() => {
    const t = props.theme
    const [keys, modes, syntax] = HELP
    if (!twoCol()) {
      const out: Seg[][] = []
      for (const [title, items] of HELP) out.push(...helpSection(title, items, t), [])
      out.push([{ text: " Esc to close", fg: t.subtle }])
      return out
    }
    const left = helpSection(keys![0], keys![1], t)
    const right = [...helpSection(modes![0], modes![1], t), [], ...helpSection(syntax![0], syntax![1], t)]
    // The left column takes what it needs; the right one gets the rest.
    const colW = Math.min(Math.floor((w() - 2) / 2), Math.max(...left.map(segsWidth)) + 3)
    const out: Seg[][] = []
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const l = fitSegs(left[i] ?? [], colW)
      const used = l.reduce((n, sg) => n + Bun.stringWidth(sg.text), 0)
      out.push([...l, { text: " ".repeat(Math.max(0, colW - used)) }, ...(right[i] ?? [])])
    }
    out.push([], [{ text: " Esc to close", fg: t.subtle }])
    return out
  })
  const height = () => Math.min(props.height - 2, rows().length + 2)
  return (
    <box
      position="absolute"
      left={Math.max(0, Math.floor((props.width - w()) / 2))}
      top={1}
      width={w()}
      height={height()}
      border
      borderStyle="rounded"
      borderColor={props.theme.borderFocus}
      backgroundColor={props.theme.panel}
      title=" zsearch help "
      titleColor={props.theme.accent}
      flexDirection="column"
      overflow="hidden"
      zIndex={20}
    >
      <For each={rows().slice(0, Math.max(0, height() - 2))}>{(segs) => <StyledLine segs={segs} width={w() - 2} bg={props.theme.panel} />}</For>
    </box>
  )
}
