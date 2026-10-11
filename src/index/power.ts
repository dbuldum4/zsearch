/**
 * Whether the computer is in a state where a big indexing pass should wait: Low Power Mode,
 * running hot, or (when the user asks for it) on battery. Read from `pmset` on macOS and from
 * /sys on Linux, at most every half a minute.
 */
import { readdirSync, readFileSync } from "node:fs"
import type { Config } from "../config.ts"

export interface PowerState {
  lowPower: boolean
  hot: boolean
  battery: boolean
}

type PowerSettings = Pick<Config, "pauseOnLowPower" | "pauseOnBattery">

const CALM: PowerState = { lowPower: false, hot: false, battery: false }

/** `pmset -g batt`: which source the Mac draws from. */
export function pmsetOnBattery(out: string): boolean {
  return /drawing from 'Battery Power'/.test(out)
}

/** `pmset -g`: the current settings, where Low Power Mode is "lowpowermode 1" (or "powermode 1"). */
export function pmsetLowPower(out: string): boolean {
  return /^\s*(?:lowpowermode|powermode)\s+1\b/m.test(out)
}

/** `pmset -g therm`: the CPU is slowed down, or macOS recorded a thermal warning. */
export function pmsetHot(out: string): boolean {
  const limit = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(out)
  if (limit && Number(limit[1]) < 100) return true
  const warning = /thermal warning level (?:set to|is) (\d+)/i.exec(out)
  return warning !== null && Number(warning[1]) > 0
}

function pmset(...args: string[]): string {
  try {
    const r = Bun.spawnSync(["/usr/bin/pmset", ...args], { stdout: "pipe", stderr: "ignore", timeout: 2000 })
    return r.success ? r.stdout.toString() : ""
  } catch { return "" }
}

function read(path: string): string {
  try { return readFileSync(path, "utf8").trim() } catch { return "" }
}

/** Linux: on battery when a battery discharges; low power with the ACPI "low-power" profile. */
export function linuxPowerState(root = "/sys"): PowerState {
  let battery = false
  let supplies: string[] = []
  try { supplies = readdirSync(`${root}/class/power_supply`) } catch {}
  for (const s of supplies) {
    const dir = `${root}/class/power_supply/${s}`
    if (read(`${dir}/type`) === "Battery" && read(`${dir}/status`) === "Discharging") battery = true
  }
  return { lowPower: read(`${root}/firmware/acpi/platform_profile`) === "low-power", hot: false, battery }
}

export function readPowerState(): PowerState {
  if (process.platform === "darwin") return { lowPower: pmsetLowPower(pmset("-g")), hot: pmsetHot(pmset("-g", "therm")), battery: pmsetOnBattery(pmset("-g", "batt")) }
  if (process.platform === "linux") return linuxPowerState()
  return CALM
}

/** Why indexing waits in this state under these settings, or null when it need not. */
export function pauseReason(state: PowerState, config: PowerSettings): string | null {
  if (config.pauseOnLowPower && state.lowPower) return "Low Power Mode"
  if (config.pauseOnLowPower && state.hot) return "the computer is hot"
  if (config.pauseOnBattery && state.battery) return "on battery"
  return null
}

/** How often the power state is read again. */
const RECHECK_MS = 30_000

/**
 * The pause reason, read again at most every `RECHECK_MS`, along with the settings (a change
 * applies to a run already going).
 */
export class PowerGate {
  private checkedAt = -Infinity
  private last: string | null = null
  private settings: () => PowerSettings

  constructor(
    settings: PowerSettings | (() => PowerSettings),
    private readState: () => PowerState = readPowerState,
    private now: () => number = Date.now,
  ) {
    this.settings = typeof settings === "function" ? settings : () => settings
  }

  reason(): string | null {
    const t = this.now()
    if (t - this.checkedAt >= RECHECK_MS) {
      this.checkedAt = t
      const settings = this.settings()
      this.last = settings.pauseOnLowPower || settings.pauseOnBattery ? pauseReason(this.readState(), settings) : null
    }
    return this.last
  }
}
