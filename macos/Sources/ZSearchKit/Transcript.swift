import Foundation

/// Transcripts of recordings as the engine stores them (src/index/extract/transcribe.ts): one
/// final segment per line, each starting with the time it begins, `[00:01:23] words…`.
public enum Transcript {
    /// The `[hh:mm:ss]` a segment starts with: its time in the recording, and where it is in the
    /// line (UTF-16, as NSString counts).
    public struct Stamp: Hashable, Sendable {
        public var seconds: Double
        public var range: NSRange
    }

    private static let seekScheme = "zsearch-seek"

    public static func isRecording(kind: String) -> Bool {
        kind == "audio" || kind == "video"
    }

    /// The stamp a transcript line starts with, if it has a whole one: a character limit can cut
    /// the last line inside its stamp.
    public static func stamp(in line: String) -> Stamp? {
        let u = Array(line.utf16.prefix(16))
        var i = 0
        func take(_ unit: Character) -> Bool {
            guard i < u.count, u[i] == unit.utf16.first else { return false }
            i += 1
            return true
        }
        func number(digits: ClosedRange<Int>) -> Int? {
            var value = 0, count = 0
            while i < u.count, count < digits.upperBound, (48...57).contains(u[i]) {
                value = value * 10 + Int(u[i] - 48)
                i += 1
                count += 1
            }
            return digits.contains(count) ? value : nil
        }
        guard take("["), let h = number(digits: 2...4), take(":"),
              let m = number(digits: 2...2), m < 60, take(":"),
              let s = number(digits: 2...2), s < 60, take("]") else { return nil }
        if i < u.count, u[i] != 32, u[i] != 9 { return nil }
        return Stamp(seconds: Double(h * 3600 + m * 60 + s), range: NSRange(location: 0, length: i))
    }

    /// "hh:mm:ss", as transcripts stamp their segments.
    public static func format(_ seconds: Double) -> String {
        let s = seconds.isFinite ? max(0, Int(seconds)) : 0
        return String(format: "%02d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
    }

    /// Where the segment of a recording's best matching line starts. The engine sends
    /// `startSeconds`, as a long line's snippet may be clipped past its stamp.
    public static func start(of hit: SearchHit) -> Double? {
        guard isRecording(kind: hit.kind), let line = hit.lines.first else { return nil }
        return line.startSeconds ?? stamp(in: line.text)?.seconds
    }

    /// Where the segment of the preview's focused match starts. Preview lines keep their start.
    public static func start(of preview: FilePreview) -> Double? {
        guard isRecording(kind: preview.kind), preview.message == nil, preview.matchLines.contains(preview.focusLine),
              let line = preview.lines.first(where: { $0.n == preview.focusLine }) else { return nil }
        return stamp(in: line.text)?.seconds
    }

    /// A link to a moment of the previewed recording, for a stamp in the preview text.
    public static func seekURL(_ seconds: Double) -> URL {
        URL(string: "\(seekScheme):\(format(seconds))")!
    }

    /// The moment a `seekURL` links to.
    public static func seconds(from url: URL) -> Double? {
        guard url.scheme == seekScheme else { return nil }
        return stamp(in: "[" + url.absoluteString.dropFirst(seekScheme.count + 1) + "]")?.seconds
    }
}
