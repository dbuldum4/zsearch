import Foundation

/// A piece of a line, marked if it is part of a match.
public struct TextRun: Hashable, Sendable {
    public var text: String
    public var highlighted: Bool

    public init(_ text: String, highlighted: Bool) {
        self.text = text
        self.highlighted = highlighted
    }
}

/// Split `text` into plain and highlighted runs. `ranges` are [start, end) offsets in UTF-16
/// code units, as JavaScript reports them. Overlaps are clipped and out-of-range parts dropped.
public func highlightRuns(_ text: String, ranges: [[Int]]) -> [TextRun] {
    let units = Array(text.utf16)
    var runs: [TextRun] = []
    var pos = 0
    func piece(_ a: Int, _ b: Int) -> String {
        String(decoding: units[a..<b], as: UTF16.self)
    }
    for r in ranges.filter({ $0.count == 2 }).sorted(by: { $0[0] < $1[0] }) {
        let a = max(r[0], pos), b = min(r[1], units.count)
        guard a < b else { continue }
        if a > pos { runs.append(TextRun(piece(pos, a), highlighted: false)) }
        runs.append(TextRun(piece(a, b), highlighted: true))
        pos = b
    }
    if pos < units.count { runs.append(TextRun(piece(pos, units.count), highlighted: false)) }
    return runs
}

/// Short label for a file kind, as the terminal UI shows it.
public func kindBadge(_ kind: String) -> String {
    switch kind {
    case "folder": return "DIR"
    case "code": return "CODE"
    case "text": return "TXT"
    case "markdown": return "MD"
    case "data": return "DATA"
    case "web": return "WEB"
    case "pdf": return "PDF"
    case "doc": return "DOC"
    case "sheet": return "XLS"
    case "slides": return "PPT"
    case "ebook": return "BOOK"
    case "email": return "MAIL"
    case "image": return "IMG"
    case "audio": return "AUD"
    case "video": return "VID"
    case "archive": return "ZIP"
    case "app": return "APP"
    default: return "FILE"
    }
}
