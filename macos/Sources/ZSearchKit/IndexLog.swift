import Foundation

/// What indexing has done, as lines of text: each phase as it starts (with what it has to do),
/// the files the engine reports working on, waits, read errors and how each run ended. Progress
/// events come a few times a second, so on a fast stretch not every file gets a line.
public struct IndexLog: Sendable {
    public struct Line: Identifiable, Hashable, Sendable {
        public let id: Int
        public let time: Date
        public let text: String
    }

    public private(set) var lines: [Line] = []
    /// Lines kept: the oldest go first.
    public let limit: Int
    /// Paths under it are shown from `~`.
    private let home: String
    private var nextID = 0
    private var last: IndexProgress?

    public init(limit: Int = 1000, home: String = NSHomeDirectory()) {
        self.limit = limit
        self.home = home
    }

    /// Add what changed since the last progress event of this run.
    public mutating func record(_ p: IndexProgress, at time: Date = Date()) {
        defer { last = p }
        if p.phase != last?.phase, let started = Self.phaseStart(p) { note(started, at: time) }
        if let waiting = p.waiting, waiting != last?.waiting { note("Waiting: \(waiting)", at: time) }
        if p.waiting == nil, last?.waiting != nil, p.phase == last?.phase { note("Resumed", at: time) }
        if p.contentErrors > (last?.contentErrors ?? 0) {
            let n = p.contentErrors
            note(n == 1 ? "1 file could not be read" : "\(n.formatted()) files could not be read", at: time)
        }
        if !p.current.isEmpty, p.current != last?.current { note(shown(p.current), at: time) }
    }

    /// A run ended: `status` as the engine says ("done", "cancelled", "error", "locked").
    public mutating func finished(_ status: String, error: String? = nil, at time: Date = Date()) {
        switch status {
        case "done": note("Finished", at: time)
        case "cancelled": note("Stopped", at: time)
        case "locked": note("Another zsearch process is updating the index", at: time)
        default: note("Failed: \(error ?? "unknown error")", at: time)
        }
        last = nil
    }

    public mutating func note(_ text: String, at time: Date = Date()) {
        lines.append(Line(id: nextID, time: time, text: text))
        nextID += 1
        if lines.count > limit { lines.removeFirst(lines.count - limit) }
    }

    /// The log as text, one line each, with times (`HH:mm:ss`).
    public func text(timeZone: TimeZone = .current) -> String {
        lines.map { "\(Self.clock($0.time, timeZone: timeZone))  \($0.text)" }.joined(separator: "\n")
    }

    public static func clock(_ date: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.hour, .minute, .second], from: date)
        return String(format: "%02d:%02d:%02d", c.hour ?? 0, c.minute ?? 0, c.second ?? 0)
    }

    private func shown(_ path: String) -> String {
        path == home || path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }

    private static func phaseStart(_ p: IndexProgress) -> String? {
        switch p.phase {
        case "scan": return p.partial == true ? "Checking changed files" : "Scanning folders"
        case "content": return "Extracting text: \(p.contentTotal.formatted()) " + (p.contentTotal == 1 ? "file" : "files") + " to read"
        case "cleanup": return "Removing deleted files from the index"
        case "meaning":
            guard let m = p.meaning else { return "Building the semantic index" }
            return "Building the semantic index: \(m.total.formatted()) " + (m.total == 1 ? "file" : "files")
        default: return nil
        }
    }
}
