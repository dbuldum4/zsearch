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
    public static func occurrences(of terms: [String], in text: String, limit: Int = 2000) -> [NSRange] {
        let text = text as NSString
        var out: [NSRange] = []
        for term in terms {
            var from = 0
            while from < text.length, out.count < limit {
                let found = text.range(of: term, options: [.caseInsensitive, .diacriticInsensitive], range: NSRange(location: from, length: text.length - from))
                guard found.location != NSNotFound, found.length > 0 else { break }
                from = found.location + found.length
                if out.contains(where: { NSIntersectionRange($0, found).length > 0 }) { continue }
                out.append(found)
            }
        }
        return out.sorted { $0.location < $1.location }
    }

    private static func sorted(_ terms: [String]) -> [String] {
        terms.enumerated().sorted { ($0.element.count, -$0.offset) > ($1.element.count, -$1.offset) }.map(\.element)
    }

    /// Find the preview's focus line on a page of the rendered document, and within it the
    /// focused match: the UTF-16 range in `pageText` to scroll to, or nil if the line isn't there.
    ///
    /// The page's own text (from PDFKit) breaks lines and spaces words differently from the
    /// indexed text, so both are compared with whitespace removed and case folded. The lines
    /// around the focus line are tried with it first, so a short line ("and", "2") is found
    /// where it really is rather than wherever those characters first appear.
    public static func locate(focusOf preview: FilePreview, in pageText: String) -> NSRange? {
        guard let index = preview.lines.firstIndex(where: { $0.n == preview.focusLine }) else { return nil }
        let line = preview.lines[index]
        let text = untruncated(line.text)
        let before = index > 0 ? untruncated(preview.lines[index - 1].text) : ""
        let after = index + 1 < preview.lines.count ? untruncated(preview.lines[index + 1].text) : ""
        let match = line.ranges.filter { $0.count == 2 && $0[0] < $0[1] }.min { $0[0] < $1[0] }
        let page = Squeezed(pageText)
        let target = Squeezed(text)
        guard !target.units.isEmpty else { return nil }

        let attempts: [(Squeezed, Int)] = [
            (Squeezed(before + "\n" + text + "\n" + after), Squeezed(before).units.count),
            (target, 0),
        ]
        for (needle, lineStart) in attempts {
            guard let at = page.find(needle.units) else { continue }
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

    /// The range in `ranges` (in reading order) nearest where the preview's focus line would be
    /// in a document of `length` UTF-16 units, if every line were as long. The fallback when
    /// `locate` can't place the line, as for a header or footnote the document view leaves out
    /// (the engine's text has those after the body), so the next match doesn't go back to the first.
    public static func nearest(_ ranges: [NSRange], toFocusOf preview: FilePreview, length: Int) -> NSRange? {
        guard !ranges.isEmpty else { return nil }
        let fraction = Double(max(0, preview.focusLine - 1)) / Double(max(1, preview.totalLines))
        let guess = Int(fraction * Double(length))
        return ranges.min { abs($0.location - guess) < abs($1.location - guess) }
    }

    /// Text with whitespace removed and case folded, remembering where each unit came from.
    struct Squeezed {
        var units: [UInt16] = []
        /// For each unit, the UTF-16 range of the character it came from in the original text.
        var origins: [(start: Int, end: Int)] = []

        init(_ text: String) {
            var offset = 0
            for scalar in text.unicodeScalars {
                let width = scalar.utf16.count
                defer { offset += width }
                if scalar.properties.isWhitespace { continue }
                for unit in String(scalar).lowercased().utf16 {
                    units.append(unit)
                    origins.append((offset, offset + width))
                }
            }
        }

        func find(_ needle: [UInt16]) -> Int? {
            guard !needle.isEmpty, needle.count <= units.count else { return nil }
            let first = needle[0]
            var i = 0
            while i <= units.count - needle.count {
                if units[i] == first, units[i..<(i + needle.count)].elementsEqual(needle) { return i }
                i += 1
            }
            return nil
        }
    }
}
