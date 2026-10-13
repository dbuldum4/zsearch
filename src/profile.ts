/** Build-time profile, also selectable for source runs and inherited by workers. */
declare const ZSEARCH_MEANING_ONLY: boolean
export function meaningOnly(): boolean {
  return typeof ZSEARCH_MEANING_ONLY !== "undefined" ? ZSEARCH_MEANING_ONLY : process.env.ZSEARCH_MEANING_ONLY === "1"
}
