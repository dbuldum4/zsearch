import Foundation

/// First-run setup: search waits behind the setup screen until the index is built, semantic
/// search included. Once setup is done it stays done: later updates run behind the search window.
public enum SetupGate {
    /// Whether the index as it is now is ready to search: a run has finished, and semantic search
    /// has vectors for every file it should know. Where semantic search cannot run (no embedding
    /// helper, or file contents off), the word index is all there is to wait for.
    public static func isReady(stats: IndexStats?, semantic: SemanticStatus?, contentsOn: Bool, indexing: Bool) -> Bool {
        guard !indexing, let stats, stats.lastIndexedAt != nil, let semantic else { return false }
        if semantic.helper == nil || !contentsOn { return true }
        guard semantic.enabled, semantic.model.ready, let coverage = stats.semantic else { return false }
        return coverage.pending == 0
    }

    /// Whether a finished run completes setup: it walked every folder, and its semantic pass got
    /// through every file it had to read. A file Granite cannot embed then stays pending without
    /// holding setup up.
    public static func completes(_ done: IndexDone, semantic: SemanticStatus?) -> Bool {
        guard done.status == "done", let p = done.progress, p.partial != true, let semantic, semantic.enabled, semantic.model.ready,
              let meaning = p.meaning, meaning.error == nil else { return false }
        return meaning.done >= meaning.total
    }
}

/// The time left in an indexing phase, from its pace since it started.
public struct RemainingTime: Sendable {
    private var phase: String?
    private var start: (time: Double, done: Int)?
    private var last = 0

    /// How long the pace is measured before there is an estimate.
    public static let warmUp: Double = 10

    public init() {}

    /// Seconds left in `phase` at `now` (seconds), or nil until the pace is known. A new phase,
    /// or a count that went back (another run), starts over.
    public mutating func update(phase: String, done: Int, total: Int, now: Double) -> Double? {
        defer { last = done }
        guard let start, phase == self.phase, done >= last else {
            self.phase = phase
            self.start = (now, done)
            return nil
        }
        if done >= total { return 0 }
        let elapsed = now - start.time
        let progressed = done - start.done
        guard elapsed >= Self.warmUp, progressed > 0 else { return nil }
        return Double(total - done) * elapsed / Double(progressed)
    }

    /// "Less than a minute left", "About 4 minutes left", "About 2 hours left".
    public static func text(_ seconds: Double) -> String {
        if seconds < 60 { return "Less than a minute left" }
        let minutes = Int((seconds / 60).rounded(.up))
        if minutes < 60 { return minutes == 1 ? "About a minute left" : "About \(minutes) minutes left" }
        let hours = Int((seconds / 3600).rounded())
        return hours <= 1 ? "About an hour left" : "About \(hours) hours left"
    }
}
