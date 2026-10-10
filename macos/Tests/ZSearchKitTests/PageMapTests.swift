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

    func testLocateWholeLineWithoutRangesAndMissingLine() throws {
        let p = try preview(focus: 1, lines: [(1, "Café au lait", [])])
        XCTAssertEqual(PageMap.locate(focusOf: p, in: "x\ncafé  au\nlait"), NSRange(location: 2, length: 13))
        XCTAssertNil(PageMap.locate(focusOf: p, in: "something else"))
        XCTAssertNil(PageMap.locate(focusOf: try preview(focus: 5, lines: [(1, "a", [])]), in: "a"))
    }
}
