/** File classification shared by the indexer, search filters and the UI. */

export type Kind =
  | "folder"
  | "code"
  | "text"
  | "markdown"
  | "data"
  | "web"
  | "pdf"
  | "doc"
  | "sheet"
  | "slides"
  | "ebook"
  | "email"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "app"
  | "other"

const CODE = `
c h cc cpp cxx hpp hh hxx ino m mm cs fs fsx fsi vb java kt kts scala sc groovy gradle clj cljs cljc edn
go rs zig nim v d dart swift py pyi pyw ipynb rb rake gemspec php phtml pl pm t lua r jl ex exs erl hrl
hs lhs ml mli elm purs re res rkt scm ss lisp el sol vy move cairo
js mjs cjs jsx ts mts cts tsx vue svelte astro
sh bash zsh fish ksh csh tcsh ps1 psm1 bat cmd awk sed
sql prisma graphql gql proto thrift avsc capnp
css scss sass less styl pcss
tf tfvars hcl nix dhall cue bzl bazel star cmake mk mak make just
asm s nasm wat glsl hlsl wgsl metal cu cuh f f90 f95 for pas pp ada adb ads cob cbl tcl vim
dockerfile containerfile makefile justfile rakefile gemfile podfile vagrantfile procfile brewfile
`
const MARKDOWN = `md markdown mdown mkd mkdn mdx rst adoc asciidoc org textile wiki pod rdoc tex latex bib`
const TEXT = `txt text log out err nfo me readme license licence changelog authors contributors copying todo notes srt vtt sub ass diff patch`
const DATA = `json jsonc json5 jsonl ndjson geojson yaml yml toml ini cfg conf config env properties prop xml xsd xsl xslt plist csv tsv psv dat lock gitignore gitattributes editorconfig npmrc htaccess`
const WEB = `html htm xhtml shtml mhtml svg`
const DOC = `doc docx docm dot dotx odt ott rtf pages wpd wps abw fodt`
const SHEET = `xls xlsx xlsm xlsb xlt xltx ods ots numbers fods`
const SLIDES = `ppt pptx pptm pps ppsx pot potx odp otp key fodp`
const EBOOK = `epub mobi azw azw3 fb2 djvu cbz cbr`
const EMAIL = `eml emlx msg mbox ics vcf`
const IMAGE = `png jpg jpeg gif bmp tif tiff webp heic heif avif ico icns raw cr2 cr3 nef arw dng orf rw2 psd xcf ai eps sketch fig`
const AUDIO = `mp3 wav flac aac m4a ogg oga opus wma aiff aif alac mid midi`
const VIDEO = `mp4 m4v mov avi mkv webm wmv flv mpg mpeg 3gp ogv`
const ARCHIVE = `zip tar gz tgz bz2 tbz xz txz zst 7z rar dmg iso img pkg deb rpm apk jar war whl gem crate`
const APP = `app exe dll so dylib a o obj class pyc pyo wasm bin elf msi appimage`

const EXT_KIND = new Map<string, Kind>()
const add = (list: string, kind: Kind) => {
  for (const e of list.split(/\s+/)) if (e) EXT_KIND.set(e, kind)
}
add(CODE, "code")
add(MARKDOWN, "markdown")
add(TEXT, "text")
add(DATA, "data")
add(WEB, "web")
add("pdf", "pdf")
add(DOC, "doc")
add(SHEET, "sheet")
add(SLIDES, "slides")
add(EBOOK, "ebook")
add(EMAIL, "email")
add(IMAGE, "image")
add(AUDIO, "audio")
add(VIDEO, "video")
add(ARCHIVE, "archive")
add(APP, "app")

/** Lower-case extension without the dot. Dotfiles like `.bashrc` have the extension "". */
export function extOf(name: string): string {
  const dot = name.lastIndexOf(".")
  if (dot <= 0 || dot === name.length - 1) return ""
  return name.slice(dot + 1).toLowerCase()
}

/** Well-known extensionless file names. */
const NAMED: Record<string, Kind> = {
  makefile: "code",
  gnumakefile: "code",
  dockerfile: "code",
  containerfile: "code",
  justfile: "code",
  rakefile: "code",
  gemfile: "code",
  podfile: "code",
  vagrantfile: "code",
  procfile: "code",
  brewfile: "code",
  jenkinsfile: "code",
  cmakelists: "code",
  readme: "text",
  license: "text",
  licence: "text",
  copying: "text",
  authors: "text",
  changelog: "text",
  notice: "text",
  todo: "text",
}

export function kindOf(name: string, isDir = false): Kind {
  if (isDir) return name.endsWith(".app") ? "app" : "folder"
  const ext = extOf(name)
  if (ext) {
    const k = EXT_KIND.get(ext)
    if (k) return k
  }
  const lower = name.toLowerCase()
  const named = NAMED[lower] ?? NAMED[lower.replace(/\.[^.]*$/, "")]
  if (named) return named
  if (lower.startsWith(".") && /(rc|profile|config|ignore|env)$/.test(lower)) return "data"
  return "other"
}

/** Kinds read as plain text (subject to binary sniffing). */
export const TEXTUAL_KINDS = new Set<Kind>(["code", "text", "markdown", "data", "web"])

/** Kinds that need a document extractor. */
export const DOCUMENT_EXTS = new Set([
  "pdf",
  "docx",
  "docm",
  "dotx",
  "xlsx",
  "xlsm",
  "xltx",
  "pptx",
  "pptm",
  "ppsx",
  "potx",
  "odt",
  "ott",
  "ods",
  "ots",
  "odp",
  "otp",
  "fodt",
  "fods",
  "fodp",
  "rtf",
  "epub",
  "doc",
  "xls",
  "ppt",
  "eml",
  "emlx",
  "pages",
  "numbers",
  "key",
  "ipynb",
])

/** Short badges for the UI. */
export const KIND_BADGE: Record<Kind, string> = {
  folder: "DIR",
  code: "CODE",
  text: "TXT",
  markdown: "MD",
  data: "DATA",
  web: "WEB",
  pdf: "PDF",
  doc: "DOC",
  sheet: "XLS",
  slides: "PPT",
  ebook: "BOOK",
  email: "MAIL",
  image: "IMG",
  audio: "AUD",
  video: "VID",
  archive: "ZIP",
  app: "APP",
  other: "FILE",
}

/** Aliases accepted by `type:` filters. */
export const KIND_ALIASES: Record<string, Kind[]> = {
  dir: ["folder"],
  dirs: ["folder"],
  folder: ["folder"],
  folders: ["folder"],
  directory: ["folder"],
  code: ["code"],
  source: ["code"],
  src: ["code"],
  text: ["text", "markdown"],
  txt: ["text"],
  md: ["markdown"],
  markdown: ["markdown"],
  note: ["markdown", "text"],
  notes: ["markdown", "text"],
  data: ["data"],
  config: ["data"],
  web: ["web"],
  html: ["web"],
  pdf: ["pdf"],
  doc: ["doc", "pdf"],
  docs: ["doc", "pdf", "markdown", "text", "slides", "sheet", "ebook"],
  document: ["doc", "pdf", "markdown", "text", "slides", "sheet", "ebook"],
  documents: ["doc", "pdf", "markdown", "text", "slides", "sheet", "ebook"],
  word: ["doc"],
  sheet: ["sheet"],
  sheets: ["sheet"],
  spreadsheet: ["sheet"],
  excel: ["sheet"],
  xls: ["sheet"],
  slides: ["slides"],
  slide: ["slides"],
  presentation: ["slides"],
  powerpoint: ["slides"],
  ppt: ["slides"],
  ebook: ["ebook"],
  book: ["ebook"],
  email: ["email"],
  mail: ["email"],
  image: ["image"],
  images: ["image"],
  img: ["image"],
  photo: ["image"],
  photos: ["image"],
  picture: ["image"],
  audio: ["audio"],
  music: ["audio"],
  sound: ["audio"],
  video: ["video"],
  videos: ["video"],
  movie: ["video"],
  archive: ["archive"],
  zip: ["archive"],
  app: ["app"],
  binary: ["app"],
  other: ["other"],
}
