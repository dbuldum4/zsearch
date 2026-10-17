import Foundation

/// Maps a preview's numbered text lines onto the pages of the document they came from, so a
/// rendered page view can open at the matching page and highlight the same words.
public enum PageMap {
    /// The 0-based page holding `line`. `pageStarts` are the 1-based first lines of each page, as
    /// the engine reports them; without any, everything is on the first page.
    public static func page(ofLine line: Int, pageStarts: [Int]) -> Int {
        var lo = 0, hi = pageStarts.count - 1, found = 0
        while lo <= hi {
            let mid = (lo + hi) / 2
            if pageStarts[mid] <= line {
                found = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return found
    }

    /// The 0-based pages holding any of `lines`, in order, each once.
    public static func pages(ofLines lines: [Int], pageStarts: [Int]) -> [Int] {
        Array(Set(lines.map { page(ofLine: $0, pageStarts: pageStarts) })).sorted()
    }

    /// The distinct pieces of text the preview highlights, longest first, at most `limit` of them.
    /// Case is folded when comparing, so "Budget" and "budget" count once.
    public static func matchedTerms(_ preview: FilePreview, limit: Int = 24) -> [String] {
        var seen = Set<String>()
        var terms: [String] = []
        for line in preview.lines {
            let text = line.text as NSString
            for r in line.ranges where r.count == 2 {
                let a = max(0, r[0]), b = min(r[1], text.length)
                guard a < b else { continue }
                let term = text.substring(with: NSRange(location: a, length: b - a)).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !term.isEmpty, seen.insert(term.lowercased()).inserted else { continue }
                terms.append(term)
                if terms.count == limit { return sorted(terms) }
            }
        }
        return sorted(terms)
    }

    /// Where `terms` occur in `text`, ignoring case and accents, in reading order and at most
    /// `limit` of them. Terms are tried in the order given (`matchedTerms` puts the longest first),
    /// so a shorter term inside a longer match is not marked twice.
    public static func occurrences(of terms: [String], in text: String, limit: Int = 100_000) -> [NSRange] {
        let text = text as NSString
        var out: [NSRange] = []
        for term in terms where out.count < limit {
            var found: [NSRange] = []
            var from = 0
            while from < text.length, out.count + found.count < limit {
                let range = text.range(of: term, options: [.caseInsensitive, .diacriticInsensitive], range: NSRange(location: from, length: text.length - from))
                guard range.location != NSNotFound, range.length > 0 else { break }
                from = NSMaxRange(range)
                found.append(range)
            }
            // Both lists are in reading order without overlaps, so one pass merges them.
            var merged: [NSRange] = []
            merged.reserveCapacity(out.count + found.count)
            var i = 0
            for range in found {
                while i < out.count, NSMaxRange(out[i]) <= range.location {
                    merged.append(out[i])
                    i += 1
                }
                if i < out.count, out[i].location < NSMaxRange(range) { continue }
                merged.append(range)
            }
            merged.append(contentsOf: out[i...])
            out = merged
        }
        return out
    }

    /// The `count` ranges of `ranges` (in reading order) nearest `location`, in reading order.
    public static func window(_ ranges: [NSRange], around location: Int, count: Int) -> [NSRange] {
        guard ranges.count > count else { return ranges }
        guard count > 0 else { return [] }
        var lo = 0, hi = ranges.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if ranges[mid].location < location { lo = mid + 1 } else { hi = mid }
        }
        // Grow [lo, hi) from the first range at or after `location`, toward the closer side.
        hi = lo
        while hi - lo < count {
            if lo == 0 {
                hi += 1
            } else if hi == ranges.count || location - ranges[lo - 1].location <= ranges[hi].location - location {
                lo -= 1
            } else {
                hi += 1
            }
        }
        return Array(ranges[lo..<hi])
    }

    /// The range of `ranges` (in reading order) nearest `location`.
    public static func nearest(_ ranges: [NSRange], to location: Int) -> NSRange? {
        window(ranges, around: location, count: 1).first
    }

    /// Where the preview's focus line would be in a document of `length` UTF-16 units if every
    /// line were as long: the guess for a line that can't be placed (a header or footnote the
    /// document view leaves out; the engine's text has those after the body) or that appears more
    /// than once.
    public static func expectedLocation(ofFocusOf preview: FilePreview, length: Int) -> Int {
        let fraction = Double(max(0, preview.focusLine - 1)) / Double(max(1, preview.totalLines))
        return Int(fraction * Double(length))
    }

    private static func sorted(_ terms: [String]) -> [String] {
        terms.enumerated().sorted { ($0.element.count, -$0.offset) > ($1.element.count, -$1.offset) }.map(\.element)
    }

    /// Find the preview's focus line on a page of the rendered document, and within it the
    /// focused match: the UTF-16 range in `pageText` to scroll to, or nil if the line isn't there.
    ///
    /// The page's own text (from PDFKit or AppKit) breaks lines and spaces words differently from
    /// the indexed text, so both are compared with whitespace removed and case folded. The lines
    /// around the focus line are tried with it first, so a short line ("and", "2") is found
    /// where it really is rather than wherever those characters first appear; then one of them
    /// at a time, for a neighbour with text the index doesn't have (a list's bullet or number).
    public static func locate(focusOf preview: FilePreview, in pageText: String) -> NSRange? {
        locate(focusOf: preview, in: PreparedText(pageText))
    }

    /// `locate` in text prepared once for several calls. Where the text sought appears more than
    /// once, the place nearest the UTF-16 offset `near` is taken, or else the first.
    public static func locate(focusOf preview: FilePreview, in prepared: PreparedText, near: Int? = nil) -> NSRange? {
        guard let index = preview.lines.firstIndex(where: { $0.n == preview.focusLine }) else { return nil }
        let line = preview.lines[index]
        let text = untruncated(line.text)
        let before = index > 0 ? untruncated(preview.lines[index - 1].text) : ""
        let after = index + 1 < preview.lines.count ? untruncated(preview.lines[index + 1].text) : ""
        let match = line.ranges.filter { $0.count == 2 && $0[0] < $0[1] }.min { $0[0] < $1[0] }
        let page = prepared.squeezed
        let target = Squeezed(text)
        guard !target.units.isEmpty else { return nil }

        let beforeUnits = Squeezed(before).units.count
        let attempts: [(String, Int)] = [
            (before + "\n" + text + "\n" + after, beforeUnits),
            (before + "\n" + text, beforeUnits),
            (text + "\n" + after, 0),
            (text, 0),
        ]
        var tried = Set<[UInt16]>()
        for (needleText, lineStart) in attempts {
            let needle = Squeezed(needleText).units
            guard tried.insert(needle).inserted, let at = page.find(needle, near: near) else { continue }
            // The focused match inside the line, or the whole line if it has no match ranges.
            var first = 0, last = target.units.count - 1
            if let match {
                guard let a = target.origins.firstIndex(where: { $0.end > match[0] }),
                      let b = target.origins.lastIndex(where: { $0.start < match[1] }), a <= b else { return nil }
                first = a
                last = b
            }
            let start = page.origins[at + lineStart + first].start
            let end = page.origins[at + lineStart + last].end
            return NSRange(location: start, length: end - start)
        }
        return nil
    }

    /// A preview line without the "…" the engine adds when it cuts a line after 2000 UTF-16 units,
    /// so the start of a long paragraph can still be found in the document.
    static func untruncated(_ line: String) -> String {
        let text = line as NSString
        guard text.length == 2001, text.hasSuffix("…") else { return line }
        // A surrogate pair the cut split arrives as U+FFFD, which the document doesn't have.
        let cut = text.character(at: 1999) == 0xFFFD ? 1999 : 2000
        return text.substring(to: cut)
    }

    /// A document's text made ready for `locate` once, so moving between its matches doesn't
    /// redo that for the whole document each time.
    public struct PreparedText: Sendable {
        let squeezed: Squeezed

        public init(_ text: String) {
            squeezed = Squeezed(text)
        }
    }

    /// Text with whitespace removed and case folded, remembering where each unit came from.
    struct Squeezed: Sendable {
        var units: [UInt16] = []
        /// For each unit, the UTF-16 range of the character it came from in the original text.
        var origins: [(start: Int, end: Int)] = []

        init(_ text: String) {
            let capacity = text.utf16.count
            units.reserveCapacity(capacity)
            origins.reserveCapacity(capacity)
            var offset = 0
            for scalar in text.unicodeScalars {
                let width = scalar.utf16.count
                defer { offset += width }
                // ASCII without building a String per character: a long document is mostly ASCII.
                let value = scalar.value
                if value < 128 {
                    // The ASCII characters Unicode counts as whitespace: tab to carriage return, and space.
                    if value == 32 || (value >= 9 && value <= 13) { continue }
                    units.append(UInt16(value >= 65 && value <= 90 ? value + 32 : value))
                    origins.append((offset, offset + 1))
                    continue
                }
                if scalar.properties.isWhitespace { continue }
                for unit in String(scalar).lowercased().utf16 {
                    units.append(unit)
                    origins.append((offset, offset + width))
                }
            }
        }

        /// Where `needle` starts: the first place, or the one whose text starts nearest the
        /// UTF-16 offset `near`.
        func find(_ needle: [UInt16], near: Int? = nil) -> Int? {
            guard !needle.isEmpty, needle.count <= units.count else { return nil }
            let first = needle[0]
            var best: Int?
            var i = 0
            while i <= units.count - needle.count {
                if units[i] == first, units[i..<(i + needle.count)].elementsEqual(needle) {
                    guard let near else { return i }
                    guard let b = best else {
                        best = i
                        i += 1
                        continue
                    }
                    // Places come in order, so once one is no nearer, none after it is.
                    guard abs(origins[i].start - near) < abs(origins[b].start - near) else { return b }
                    best = i
                }
                i += 1
            }
            return best
        }
    }
}
