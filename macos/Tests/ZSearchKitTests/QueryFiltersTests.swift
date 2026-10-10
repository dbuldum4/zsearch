import XCTest
@testable import ZSearchKit

final class QueryFiltersTests: XCTestCase {
    typealias Q = QueryFilters

    func testReadsFilterValues() {
        let q = "budget type:pdf in:~/Documents -type:image modified:week"
        XCTAssertEqual(Q.value(Q.typeKeys, in: q), "pdf")
        XCTAssertEqual(Q.value(Q.folderKeys, in: q), "~/Documents")
        XCTAssertEqual(Q.value(Q.modifiedKeys, in: q), "week")
        XCTAssertNil(Q.value(Q.sizeKeys, in: q))
        XCTAssertEqual(Q.value(Q.modifiedKeys, in: "after:2024-01-01"), "2024-01-01")
        XCTAssertEqual(Q.key(Q.modifiedKeys, in: "after:2024-01-01"), "after")
        // Unknown keys and quoted phrases are plain text.
        XCTAssertNil(Q.value(Q.typeKeys, in: "\"type:pdf\" note:x"))
        XCTAssertFalse(Q.hasFilters("http://x note:y"))
    }

    func testSetsReplacesAndRemovesFilters() {
        XCTAssertEqual(Q.setting(Q.typeKeys, to: "pdf", in: ""), "type:pdf")
        XCTAssertEqual(Q.setting(Q.typeKeys, to: "pdf", in: "budget"), "budget type:pdf")
        XCTAssertEqual(Q.setting(Q.typeKeys, to: "pdf", in: "budget "), "budget type:pdf")
        XCTAssertEqual(Q.setting(Q.typeKeys, to: "image", in: "kind:pdf budget"), "budget type:image")
        XCTAssertEqual(Q.setting(Q.typeKeys, to: nil, in: "a type:pdf b"), "a b")
        XCTAssertEqual(Q.setting(Q.typeKeys, to: nil, in: "a type:pdf"), "a")
        XCTAssertEqual(Q.setting(Q.typeKeys, to: nil, in: "type:pdf a"), "a")
        // Negated filters are left alone.
        XCTAssertEqual(Q.setting(Q.typeKeys, to: "docs", in: "-type:pdf"), "-type:pdf type:docs")
        // Mode prefixes stay in front.
        XCTAssertEqual(Q.setting(Q.extKeys, to: "md", in: "re:fo+"), "re:fo+ ext:md")
        XCTAssertEqual(Q.setting(Q.modifiedKeys, to: "today", in: "after:2024 x"), "x modified:today")
    }

    func testQuotesValuesWithSpaces() {
        let q = Q.setting(Q.folderKeys, to: "~/My Folder", in: "notes")
        XCTAssertEqual(q, "notes in:\"~/My Folder\"")
        XCTAssertEqual(Q.value(Q.folderKeys, in: q), "~/My Folder")
        XCTAssertEqual(Q.setting(Q.folderKeys, to: nil, in: q), "notes")
        XCTAssertEqual(Q.setting(Q.folderKeys, to: "~/Downloads", in: q), "notes in:~/Downloads")
    }

    func testClearsFilters() {
        XCTAssertTrue(Q.hasFilters("a size:>1mb"))
        XCTAssertEqual(Q.clearingFilters("a size:>1mb ext:pdf b -type:image"), "a b")
        XCTAssertEqual(Q.clearingFilters("re:x+ in:~/Code"), "re:x+")
    }

    func testRegexToggle() {
        XCTAssertFalse(Q.isRegex("budget"))
        XCTAssertTrue(Q.isRegex("re:fo+"))
        XCTAssertTrue(Q.isRegex("  regex:fo+"))
        XCTAssertTrue(Q.isRegex("/fo+/i ext:md"))
        XCTAssertFalse(Q.isRegex("find:/fo+/"))
        XCTAssertFalse(Q.isRegex("/"))

        XCTAssertEqual(Q.settingRegex(true, in: "fo+ ext:md"), "re:fo+ ext:md")
        XCTAssertEqual(Q.settingRegex(true, in: "fuzzy:abc"), "re:abc")
        XCTAssertEqual(Q.settingRegex(true, in: "re:x"), "re:x")
        XCTAssertEqual(Q.settingRegex(false, in: "re:fo+ ext:md"), "fo+ ext:md")
        XCTAssertEqual(Q.settingRegex(false, in: "/fo+/i ext:md"), "fo+ ext:md")
        XCTAssertEqual(Q.settingRegex(false, in: "ext:md /a b/"), "ext:md a b")
        XCTAssertEqual(Q.settingRegex(false, in: "plain"), "plain")
    }
}
