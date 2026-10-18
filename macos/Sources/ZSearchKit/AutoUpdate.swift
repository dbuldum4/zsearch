import Foundation

/// When the app updates the index by itself, following the "Update the index" setting.
public enum AutoUpdate {
    /// How often the app checks whether an update is due.
    public static let checkInterval: TimeInterval = 60

    /// Whether an update is due: `minutes` (0: only when asked) have passed since the last
    /// completed full walk, and since the last automatic attempt, so an update that fails or finds
    /// the index locked is retried once a period rather than at every check. Refreshes of the
    /// files that changed do not count: the full walk catches what file events missed.
    /// Times are milliseconds since 1970, as the engine reports them.
    public static func isDue(minutes: Double, lastFullWalkAt: Double?, lastAttempt: Double? = nil, now: Double) -> Bool {
        guard minutes > 0 else { return false }
        let period = minutes * 60_000
        if let last = lastFullWalkAt, now - last < period { return false }
        if let attempt = lastAttempt, now - attempt < period { return false }
        return true
    }
}
