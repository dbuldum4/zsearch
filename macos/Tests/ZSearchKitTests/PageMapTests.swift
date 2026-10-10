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
}
