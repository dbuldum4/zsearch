export interface RetryClock {
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
}
export const retryClock: RetryClock = { setTimeout, clearTimeout }
