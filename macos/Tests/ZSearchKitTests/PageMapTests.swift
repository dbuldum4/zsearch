import Foundation
import XCTest
@testable import ZSearchKit

final class PageMapTests: XCTestCase {
    func testPageOfLine() {
        let starts = [1, 10, 25]
        XCTAssertEqual(PageMap.page(ofLine: 1, pageStarts: starts), 0)
        XCTAssertEqual(PageMap.page(ofLine: 9, pageStarts: starts), 0)
        XCTAssertEqual(PageMap.page(ofLine: 10, pageStarts: starts), 1)
        XCTAssertEqual(PageMap.page(ofLine: 24, pageStarts: starts), 1)
        XCTAssertEqual(PageMap.page(ofLine: 25, pageStarts: starts), 2)
        XCTAssertEqual(PageMap.page(ofLine: 9999, pageStarts: starts), 2)
        XCTAssertEqual(PageMap.page(ofLine: 7, pageStarts: []), 0)
    }

    func testPagesOfLines() {
        XCTAssertEqual(PageMap.pages(ofLines: [30, 2, 3, 11, 26], pageStarts: [1, 10, 25]), [0, 1, 2])
        XCTAssertEqual(PageMap.pages(ofLines: [], pageStarts: [1, 10]), [])
    }

    func testMatchedTerms() throws {
        let json = """
        {"id":1,"path":"/a.pdf","display":"a.pdf","kind":"pdf","isDir":false,"size":1,"mtime":0,
         "lines":[{"n":1,"text":"Budget for the budget year","ranges":[[0,6],[15,21]]},
                  {"n":2,"text":"naïve café ✓ total","ranges":[[6,10],[13,18],[40,50],[3,3]]}],
         "totalLines":2,"focusLine":1,"pageStarts":[1],"matchLines":[1,2],"source":"index"}
        """
        let p = try JSONDecoder().decode(FilePreview.self, from: Data(json.utf8))
        XCTAssertEqual(PageMap.matchedTerms(p), ["Budget", "total", "café"])
        XCTAssertEqual(PageMap.matchedTerms(p, limit: 1), ["Budget"])
    }

    func testOccurrences() {
        let text = "Budget: the budget-to-budgets ratio. BUDGET"
        let ranges = PageMap.occurrences(of: ["budgets", "budget"], in: text)
        XCTAssertEqual(ranges.map { (text as NSString).substring(with: $0) }, ["Budget", "budget", "budgets", "BUDGET"])
        XCTAssertEqual(ranges.map(\.location), [0, 12, 22, 37])
        XCTAssertEqual(PageMap.occurrences(of: ["budget"], in: text, limit: 2).count, 2)
        XCTAssertEqual(PageMap.occurrences(of: ["missing", ""], in: text), [])
        XCTAssertEqual(PageMap.occurrences(of: ["budget"], in: ""), [])
    }

    private func preview(focus: Int, lines: [(Int, String, [[Int]])]) throws -> FilePreview {
        let encoded = lines.map { ["n": $0.0, "text": $0.1, "ranges": $0.2] as [String: Any] }
        let object: [String: Any] = [
            "id": 1, "path": "/a.pdf", "display": "a.pdf", "kind": "pdf", "isDir": false, "size": 1, "mtime": 0,
            "lines": encoded, "totalLines": lines.count, "focusLine": focus, "pageStarts": [1],
            "matchLines": lines.filter { !$0.2.isEmpty }.map { $0.0 }, "source": "index",
        ]
        return try JSONDecoder().decode(FilePreview.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testLocateFindsTheFocusedMatchNotTheFirstWord() throws {
        // `re:foo|barbaz`: the focus line has "foo" before "barbaz"; the jump goes to its "foo",
        // not to an earlier "foo" elsewhere on the page or to the longer term.
        let p = try preview(focus: 2, lines: [(1, "intro foo", [[6, 9]]), (2, "then foo and barbaz", [[5, 8], [13, 19]]), (3, "end", [])])
        let page = "intro foo\nthen   foo and\nbarbaz\nend" as NSString
        let range = try XCTUnwrap(PageMap.locate(focusOf: p, in: page as String))
        XCTAssertEqual(range, NSRange(location: 17, length: 3))
        XCTAssertEqual(page.substring(with: range), "foo")
    }

    func testLocateUsesTheNeighbouringLinesForShortLines() throws {
        // "2" appears earlier on the page, but only the second one sits between these lines.
        let p = try preview(focus: 2, lines: [(1, "det =", []), (2, "2", [[0, 1]]), (3, "x3", [])])
        let page = "page 2 of 9\nDet = 2 x3" as NSString
        let range = try XCTUnwrap(PageMap.locate(focusOf: p, in: page as String))
        XCTAssertEqual(range.location, page.range(of: "= 2").location + 2)
        XCTAssertEqual(range.length, 1)
    }

    func testLocateFindsALineTheEngineCut() throws {
        // A paragraph over 2000 characters comes as its first 2000 and "…", which the document doesn't have.
        let paragraph = "intro budget " + String(repeating: "lorem ", count: 400)
        let cut = String(paragraph.prefix(2000)) + "…"
        let p = try preview(focus: 2, lines: [(1, "Title", []), (2, cut, [[6, 12]]), (3, "End", [])])
        let document = "Title\n" + paragraph + "\nEnd"
        XCTAssertEqual(PageMap.locate(focusOf: p, in: document), NSRange(location: 12, length: 6))
    }

    func testUntruncated() {
        let long = String(repeating: "a", count: 2000)
        XCTAssertEqual(PageMap.untruncated(long + "…"), long)
        XCTAssertEqual(PageMap.untruncated("short…"), "short…")
        XCTAssertEqual(PageMap.untruncated(String(long.dropLast()) + "…"), String(long.dropLast()) + "…")
        // The engine cut between the two halves of "😀"; the lone half decodes as U+FFFD.
        XCTAssertEqual(PageMap.untruncated(String(repeating: "a", count: 1999) + "\u{FFFD}…"), String(repeating: "a", count: 1999))
    }

    func testExpectedLocationAndNearest() throws {
        let lines = (1...10).map { ($0, "line \($0)", [[Int]]()) }
        XCTAssertEqual(PageMap.expectedLocation(ofFocusOf: try preview(focus: 1, lines: lines), length: 100), 0)
        XCTAssertEqual(PageMap.expectedLocation(ofFocusOf: try preview(focus: 9, lines: lines), length: 100), 80)
        let ranges = [NSRange(location: 0, length: 3), NSRange(location: 50, length: 3), NSRange(location: 90, length: 3)]
        XCTAssertEqual(PageMap.nearest(ranges, to: 80)?.location, 90)
        XCTAssertEqual(PageMap.nearest(ranges, to: 60)?.location, 50)
        XCTAssertEqual(PageMap.nearest(ranges, to: 0)?.location, 0)
        XCTAssertEqual(PageMap.nearest(ranges, to: 500)?.location, 90)
        XCTAssertNil(PageMap.nearest([], to: 10))
    }

    func testWindowKeepsTheMatchesNearestTheFocus() {
        let ranges = (0..<100).map { NSRange(location: $0 * 10, length: 2) }
        XCTAssertEqual(PageMap.window(ranges, around: 503, count: 4).map(\.location), [490, 500, 510, 520])
        XCTAssertEqual(PageMap.window(ranges, around: 0, count: 3).map(\.location), [0, 10, 20])
        XCTAssertEqual(PageMap.window(ranges, around: 5000, count: 3).map(\.location), [970, 980, 990])
        XCTAssertEqual(PageMap.window(ranges, around: 5, count: 200).count, 100)
        XCTAssertEqual(PageMap.window(ranges, around: 5, count: 0), [])
    }

    func testOccurrencesOfACommonWordReachTheEnd() {
        // Thousands of matches of one term, and a longer term that takes some of them.
        let text = String(repeating: "ab ", count: 5000) + "abc"
        let all = PageMap.occurrences(of: ["abc", "ab"], in: text)
        XCTAssertEqual(all.count, 5001)
        XCTAssertEqual(all.last, NSRange(location: 15000, length: 3))
        XCTAssertEqual(PageMap.window(all, around: 15000, count: 2000).last, NSRange(location: 15000, length: 3))
    }

    func testLocateNextToAListBullet() throws {
        // The document view shows a list's bullets; the indexed text doesn't have them.
        let p = try preview(focus: 2, lines: [(1, "Revenue", []), (2, "Total", [[0, 5]]), (3, "Costs", [])])
        let document = "Total of all pages\n• Revenue\nTotal\n• Costs" as NSString
        let range = try XCTUnwrap(PageMap.locate(focusOf: p, in: document as String))
        XCTAssertEqual(range, NSRange(location: document.range(of: "Total", options: .backwards).location, length: 5))
        XCTAssertEqual(range.location, 29)
    }

    func testLocateNearPicksTheClosestRepeat() throws {
        // The same short line twice, and neighbours the document doesn't have next to it.
        let p = try preview(focus: 2, lines: [(1, "x", []), (2, "Total", [[0, 5]]), (3, "y", [])])
        let document = "Total\n" + String(repeating: "filler ", count: 20) + "\nTotal"
        let prepared = PageMap.PreparedText(document)
        XCTAssertEqual(PageMap.locate(focusOf: p, in: prepared)?.location, 0)
        XCTAssertEqual(PageMap.locate(focusOf: p, in: prepared, near: (document as NSString).length)?.location, (document as NSString).length - 5)
        XCTAssertEqual(PageMap.locate(focusOf: p, in: prepared, near: 10)?.location, 0)
    }

    func testLocateWholeLineWithoutRangesAndMissingLine() throws {
        let p = try preview(focus: 1, lines: [(1, "Café au lait", [])])
        XCTAssertEqual(PageMap.locate(focusOf: p, in: "x\ncafé  au\nlait"), NSRange(location: 2, length: 13))
        XCTAssertNil(PageMap.locate(focusOf: p, in: "something else"))
        XCTAssertNil(PageMap.locate(focusOf: try preview(focus: 5, lines: [(1, "a", [])]), in: "a"))
    }
}
