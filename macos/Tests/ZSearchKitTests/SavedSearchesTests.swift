import Foundation
import XCTest
@testable import ZSearchKit

final class SavedSearchesTests: XCTestCase {
    private let saved = [
        SavedSearch(name: "Large downloads", query: "in:~/Downloads size:>100mb sort:-size", mode: .find),
        SavedSearch(name: "Project notes", query: "notes", mode: .fuzzy),
    ]

    func testNames() {
        XCTAssertEqual(SavedSearches.normalized("  Recent \t invoices "), "Recent invoices")
        XCTAssertEqual(SavedSearches.existing(named: "large DOWNLOADS", in: saved)?.name, "Large downloads")
        XCTAssertNil(SavedSearches.existing(named: "Large", in: saved))
        XCTAssertEqual(SavedSearches.problem(with: "   ", in: saved), "Enter a name.")
        XCTAssertNotNil(SavedSearches.problem(with: String(repeating: "x", count: 101), in: saved))
        // The engine's limit is in UTF-16 code units: 51 emoji are 102.
        XCTAssertNotNil(SavedSearches.problem(with: String(repeating: "😀", count: 51), in: saved))
        XCTAssertNil(SavedSearches.problem(with: String(repeating: "😀", count: 50), in: saved))
        // Case matching has no locale rules, exactly as the engine's: "I" is "i", Turkish İ is
        // not i, ß folds to SS, and precomposed and decomposed accents are the same name.
        XCTAssertTrue(SavedSearches.sameName("I", "i"))
        XCTAssertFalse(SavedSearches.sameName("İ", "i"))
        XCTAssertNil(SavedSearches.existing(named: "ınvoices", in: [SavedSearch(name: "İnvoices", query: "q", mode: .find)]))
        XCTAssertTrue(SavedSearches.sameName("straße", "STRASSE"))
        XCTAssertTrue(SavedSearches.sameName("café", "CAFÉ"))
        // Saving under a taken name replaces that search; renaming onto another one is refused.
        XCTAssertNil(SavedSearches.problem(with: "project notes", in: saved))
        XCTAssertEqual(SavedSearches.problem(with: "project notes", in: saved, renaming: saved[0]), "A saved search is already called “Project notes”.")
        XCTAssertNil(SavedSearches.problem(with: "PROJECT NOTES", in: saved, renaming: saved[1]))
    }

    func testSuggestedNames() {
        XCTAssertEqual(SavedSearches.suggestedName(for: "invoice  type:pdf mtime:<30d"), "invoice")
        XCTAssertEqual(SavedSearches.suggestedName(for: "type:pdf mtime:<30d"), "type:pdf mtime:<30d")
        XCTAssertEqual(SavedSearches.suggestedName(for: String(repeating: "word ", count: 20)), "word word word word word word word word…")
    }

    func testMatchingAndRemembering() {
        XCTAssertEqual(SavedSearches.matching(query: " notes ", mode: .fuzzy, in: saved)?.name, "Project notes")
        XCTAssertNil(SavedSearches.matching(query: "notes", mode: .find, in: saved))
        let recent = [RecentSearch(query: "budget", mode: .find, at: 2), RecentSearch(query: "report", mode: .find, at: 1)]
        XCTAssertFalse(SavedSearches.shouldRemember(query: "  ", mode: .find, recent: recent))
        XCTAssertFalse(SavedSearches.shouldRemember(query: "budget ", mode: .find, recent: recent))
        XCTAssertTrue(SavedSearches.shouldRemember(query: "budget", mode: .fuzzy, recent: recent))
        XCTAssertTrue(SavedSearches.shouldRemember(query: "report", mode: .find, recent: recent))
        XCTAssertTrue(SavedSearches.shouldRemember(query: "report", mode: .find, recent: []))
    }

    func testMenuTitles() {
        XCTAssertEqual(SavedSearches.menuTitle(query: "budget", mode: .semantic), "budget")
        XCTAssertEqual(SavedSearches.menuTitle(query: "budget", mode: .find), "budget · Find")
        XCTAssertEqual(SavedSearches.menuTitle(query: "budget", mode: .fuzzy), "budget · Fuzzy")
        XCTAssertTrue(SavedSearches.menuTitle(query: String(repeating: "a", count: 80), mode: .semantic).hasSuffix("…"))
    }

    func testRequestsAndReplies() throws {
        func json(_ request: Request) throws -> [String: String] {
            let object = try JSONSerialization.jsonObject(with: try request.encoded(id: 7)) as? [String: Any]
            return try XCTUnwrap(object).compactMapValues { $0 as? String }
        }
        XCTAssertEqual(try json(.searches), ["type": "searches"])
        XCTAssertEqual(try json(.saveSearch(name: "Invoices", query: "invoice type:pdf", mode: .find)),
                       ["type": "saveSearch", "name": "Invoices", "query": "invoice type:pdf", "mode": "find"])
        XCTAssertEqual(try json(.renameSearch(name: "Invoices", to: "Bills")), ["type": "renameSearch", "name": "Invoices", "to": "Bills"])
        XCTAssertEqual(try json(.deleteSearch(name: "Bills")), ["type": "deleteSearch", "name": "Bills"])
        XCTAssertEqual(try json(.rememberSearch(query: "budget", mode: .fuzzy)), ["type": "rememberSearch", "query": "budget", "mode": "fuzzy"])
        XCTAssertEqual(try json(.clearRecent), ["type": "clearRecent"])

        let line = #"{"id":7,"type":"searches","saved":[{"name":"Invoices","query":"invoice type:pdf","mode":"find"}],"recent":[{"query":"budget","mode":"fuzzy","at":1700000000000}]}"#
        let envelope = try Envelope.decode(Data(line.utf8))
        XCTAssertEqual(envelope.id, 7)
        guard case let .searches(s) = envelope.message else { return XCTFail("expected searches") }
        XCTAssertEqual(s.saved, [SavedSearch(name: "Invoices", query: "invoice type:pdf", mode: .find)])
        XCTAssertEqual(s.recent, [RecentSearch(query: "budget", mode: .fuzzy, at: 1_700_000_000_000)])
    }
}
