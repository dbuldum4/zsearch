import { RGBA } from "@opentui/core"
import type { Kind } from "../kinds.ts"

export interface Theme {
  name: "dark" | "light"
  text: string
  muted: string
  subtle: string
  faint: string
  accent: string
  accentText: string
  border: string
  borderFocus: string
  selection: string
  panel: string
  match: string
  matchBg: string
  ok: string
  warn: string
  error: string
  kinds: Record<Kind, string>
}

const kindsDark: Record<Kind, string> = {
  folder: "#7aa2f7",
  code: "#9ece6a",
  text: "#c0caf5",
  markdown: "#73daca",
  data: "#e0af68",
  web: "#ff9e64",
  pdf: "#f7768e",
  doc: "#7dcfff",
  sheet: "#9ece6a",
  slides: "#ff9e64",
  ebook: "#bb9af7",
  email: "#e0af68",
  image: "#bb9af7",
  audio: "#2ac3de",
  video: "#f7768e",
  archive: "#a9b1d6",
  app: "#a9b1d6",
  other: "#787c99",
}

const kindsLight: Record<Kind, string> = {
  folder: "#2e5cb8",
  code: "#33635c",
  text: "#343b58",
  markdown: "#166775",
  data: "#8f5e15",
  web: "#965027",
  pdf: "#8c4351",
  doc: "#0f4b6e",
  sheet: "#33635c",
  slides: "#965027",
  ebook: "#5a4a78",
  email: "#8f5e15",
  image: "#5a4a78",
  audio: "#166775",
  video: "#8c4351",
  archive: "#4c505e",
  app: "#4c505e",
  other: "#6c6e75",
}

export const DARK: Theme = {
  name: "dark",
  text: "#c0caf5",
  muted: "#9aa5ce",
  subtle: "#636a8c",
  faint: "#3b4261",
  accent: "#7aa2f7",
  accentText: "#16161e",
  border: "#3b4261",
  borderFocus: "#7aa2f7",
  selection: "#283457",
  panel: "#1f2335",
  match: "#ff9e64",
  matchBg: "#3d3355",
  ok: "#9ece6a",
  warn: "#e0af68",
  error: "#f7768e",
  kinds: kindsDark,
}

export const LIGHT: Theme = {
  name: "light",
  text: "#343b58",
  muted: "#4c505e",
  subtle: "#6c6e75",
  faint: "#c4c8da",
  accent: "#2e5cb8",
  accentText: "#ffffff",
  border: "#a8aecb",
  borderFocus: "#2e5cb8",
  selection: "#d5daf0",
  panel: "#e9e9ed",
  match: "#b15c00",
  matchBg: "#f3dfc4",
  ok: "#33635c",
  warn: "#8f5e15",
  error: "#8c4351",
  kinds: kindsLight,
}

const cache = new Map<string, RGBA>()
export function rgba(hex: string): RGBA {
  let c = cache.get(hex)
  if (!c) cache.set(hex, (c = RGBA.fromHex(hex)))
  return c
}
