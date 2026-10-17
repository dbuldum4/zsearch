import { cappedText, trackProcess } from "../../util/process.ts"

/** One deadline shared by first-use language-asset preparation and recognition. */
export const TRANSCRIPTION_TIMEOUT_MS = 30 * 60_000
export const TRANSCRIPTION_MAX_SECONDS = 2 * 60 * 60

async function run(tool: string, args: string[], timeoutMs: number) {
  const p = trackProcess(Bun.spawn([tool, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }))
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs)
  try {
    const [out, err, code] = await Promise.all([
      cappedText(p.stdout, 16 * 1024 * 1024, () => p.kill("SIGKILL")),
      cappedText(p.stderr, 8192, () => p.kill("SIGKILL")),
      p.exited,
    ])
    return { out, err, code, interrupted: !!p.signalCode }
  } finally {
    clearTimeout(timer)
    p.kill("SIGKILL")
    await p.exited
  }
}

// One preparation per extraction run. Keep a failed download too: hundreds of recordings must
// not each retry the same unavailable service or asset download during this pass.
let preparation: { key: string; ready: Promise<void> } | undefined
function prepare(tool: string, locale: string, runId: string, timeoutMs: number): Promise<void> {
  const key = JSON.stringify([tool, locale, runId])
  if (preparation?.key !== key) preparation = { key, ready: run(tool, ["--prepare", "--locale", locale], timeoutMs).then((r) => {
    if (r.code !== 0 || r.interrupted) throw new Error(`Apple speech is not ready: ${r.err.trim().slice(0, 200) || "asset preparation timed out"}`)
  }) }
  return preparation.ready
}

/** Final segments are JSON lines; a killed helper may leave an incomplete last line. */
export async function transcribe(tool: string, path: string, locale: string, maxChars: number, timeoutMs = TRANSCRIPTION_TIMEOUT_MS, runId?: string): Promise<{ text: string; truncated: boolean }> {
  const deadline = performance.now() + timeoutMs
  if (runId) await prepare(tool, locale, runId, timeoutMs)
  const remaining = deadline - performance.now()
  if (remaining <= 0) throw new Error("Transcription did not finish: asset preparation exhausted the deadline")
  const { out, err, code, interrupted } = await run(tool, ["transcribe", path, "--locale", locale, "--max-seconds", String(TRANSCRIPTION_MAX_SECONDS), "--max-chars", String(Math.min(maxChars, 2_000_000))], remaining)
  const lines: string[] = []
  let complete = false, truncated = false, chars = 0
  for (const line of out.split("\n").slice(0, -1)) {
    if (!line.trim()) continue
    const r: unknown = JSON.parse(line)
    if (!r || typeof r !== "object") throw new Error("invalid transcription response")
    if ("complete" in r && r.complete === true) {
      complete = true
      truncated = "truncated" in r && r.truncated === true
    } else if ("text" in r && typeof r.text === "string" && "start" in r && typeof r.start === "number" && Number.isFinite(r.start) && r.start >= 0) {
      const seconds = Math.floor(r.start)
      const stamp = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, "0")).join(":")
      const text = `[${stamp}] ${r.text.replace(/\s+/g, " ").trim()}`
      if (chars < maxChars) lines.push(text.slice(0, maxChars - chars))
      chars += text.length + 1
    } else throw new Error("invalid transcription response")
  }
  if (code !== 0 && !interrupted) throw new Error(`Transcription failed: ${err.trim().slice(0, 200) || `exit ${code}`}`)
  if (!complete && !lines.length) throw new Error(`Transcription did not finish: ${err.trim().slice(0, 200) || "deadline reached"}`)
  return { text: lines.join("\n"), truncated: truncated || !complete || chars > maxChars }
}
