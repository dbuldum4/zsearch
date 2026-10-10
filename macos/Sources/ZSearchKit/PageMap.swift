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

    private static func sorted(_ terms: [String]) -> [String] {
        terms.enumerated().sorted { ($0.element.count, -$0.offset) > ($1.element.count, -$1.offset) }.map(\.element)
    }
}
