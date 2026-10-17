import XCTest
@testable import ZSearchKit

final class QueryFiltersTests: XCTestCase {
    typealias Q = QueryFilters

    func testSemanticOnlyKeepsEveryQueryInSemanticMode() {
        XCTAssertEqual(Q.semanticOnly("fuzzy: report"), "semantic:fuzzy: report")
        XCTAssertEqual(Q.semanticOnly("/inv.*ice/"), "semantic:/inv.*ice/")
        XCTAssertEqual(Q.semanticOnly("lease ext:pdf"), "semantic:lease ext:pdf")
        XCTAssertEqual(Q.semanticOnly(""), "")
        XCTAssertEqual(Q.semanticOnly("  "), "  ")
        // The filters still read through the prefix.
        XCTAssertEqual(Q.value(Q.extKeys, in: Q.semanticOnly("lease ext:pdf")), "pdf")
    }

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

    func testIsTypeAliases() {
        // `is:pdf` is a type filter, so picking another type replaces it.
        XCTAssertEqual(Q.value(Q.typeKeys, in: "is:pdf budget"), "pdf")
        XCTAssertEqual(Q.setting(Q.typeKeys, to: "image", in: "is:pdf budget"), "budget type:image")
        XCTAssertEqual(Q.setting(Q.typeKeys, to: nil, in: "budget is:pdf"), "budget")
        // An `is:` the engine doesn't know stays as text.
        XCTAssertNil(Q.value(Q.typeKeys, in: "is:open"))
        XCTAssertFalse(Q.hasFilters("is:open"))
        XCTAssertEqual(Q.setting(Q.typeKeys, to: "pdf", in: "is:open"), "is:open type:pdf")
    }

    func testUnknownTypes() {
        XCTAssertTrue(Q.isUnknownType("docx"))
        XCTAssertTrue(Q.isUnknownType("imgae,heic"))
        XCTAssertFalse(Q.isUnknownType("pdf"))
        XCTAssertFalse(Q.isUnknownType("Word"))
        XCTAssertFalse(Q.isUnknownType("pdf,docx"))
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

    func testRecognizesAndClearsEveryEngineFilter() {
        for filter in ["created:today", "tag:work", "name:*.pdf", "sort:-date", "case:on", "word:on", "diacritics:off", "near:3", "fold:on"] {
            let query = "budget \(filter)"
            XCTAssertTrue(Q.hasFilters(query), filter)
            XCTAssertEqual(Q.clearingFilters(query), "budget", filter)
        }
        let query = #"budget ext:pdf tag:"annual report" -created:today name:*.pdf case:on"#
        XCTAssertEqual(Q.clearingFilters(query), "budget")
        XCTAssertEqual(Q.clearingFilters(#""tag:work" in:"~/Reports tag:work" budget"#), #""tag:work" budget"#)
    }

    func testSortPreservesQuotedTextAndPaths() {
        for query in [#""sort:name""#, #"in:"~/Reports sort:2026" budget"#, #"tag:"sort:name annual" budget"#] {
            let ascending = Q.togglingSort("name", in: query)
            XCTAssertEqual(ascending, query + " sort:name")
            let descending = Q.togglingSort("name", in: ascending)
            XCTAssertEqual(descending, query + " sort:-name")
            XCTAssertEqual(Q.togglingSort("name", in: descending), ascending)
        }
        XCTAssertEqual(Q.togglingSort("date", in: "re:budget sort:name"), "re:budget sort:date")
        XCTAssertEqual(Q.togglingSort("name", in: "budget sort:size sort:date"), "budget sort:name")
    }

    func testFoldPreservesQuotedTextAndPaths() {
        let query = #"in:"~/Reports fold:on" "fold:on""#
        XCTAssertEqual(Q.togglingFold(in: query), query + " fold:on")
        XCTAssertEqual(Q.togglingFold(in: query + " fold:on"), query + " fold:off")
        XCTAssertEqual(Q.togglingFold(in: "budget fold:TRUE"), "budget fold:off")
    }

    func testRegexFlagsMatchTheEngine() {
        for flags in ["", "d", "g", "i", "m", "s", "u", "v", "y", "gims"] {
            let query = "/budget/\(flags) ext:pdf tag:work"
            XCTAssertTrue(Q.isRegex(query), flags)
            XCTAssertEqual(Q.settingRegex(false, in: query), "budget ext:pdf tag:work", flags)
            XCTAssertEqual(Q.settingRegex(false, in: "re:" + query), "budget ext:pdf tag:work", flags)
        }
        XCTAssertFalse(Q.isRegex("/budget/x"))
        XCTAssertEqual(Q.settingRegex(false, in: "/budget/x"), "/budget/x")
        XCTAssertTrue(Q.isRegex("/first\nsecond/g"))
        XCTAssertEqual(Q.settingRegex(false, in: "ext:pdf /first\nsecond/g"), "ext:pdf first\nsecond")
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
