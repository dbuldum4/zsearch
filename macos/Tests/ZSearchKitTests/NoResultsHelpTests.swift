import Foundation
import XCTest
@testable import ZSearchKit

final class NoResultsHelpTests: XCTestCase {
    func reply(_ line: String) throws -> DiagnosisReply {
        guard case let .diagnosis(r) = try Envelope.decode(Data(line.utf8)).message else {
            XCTFail("expected a diagnosis")
            throw CocoaError(.coderReadCorrupt)
        }
        return r
    }

    func diagnosis(_ json: String) throws -> SearchDiagnosis? {
        try reply(#"{"type":"diagnosis","id":1,"query":"q","mode":"find","diagnosis":"# + json + "}").diagnosis
    }

    func response(query: String, mode: String = "find", hits: Int = 0, error: String? = nil) throws -> SearchResponse {
        let hit = #"{"id":1,"path":"/a","display":"a","kind":"text","isDir":false,"size":1,"mtime":0,"score":1,"sources":["name"],"namePositions":[],"lines":[],"matchCount":0}"#
        var body: [String: Any] = [
            "query": query, "mode": mode, "resolved": mode, "strategy": "", "total": hits, "elapsedMs": 1, "partial": false,
            "hits": try (0..<hits).map { _ in try JSONSerialization.jsonObject(with: Data(hit.utf8)) },
        ]
        if let error { body["error"] = error }
        return try JSONDecoder().decode(SearchResponse.self, from: JSONSerialization.data(withJSONObject: body))
    }

    func testDecodesEveryPartAndOffersActions() throws {
        let d = try diagnosis(#"""
        {"folders":[{"path":"~/Projects","reason":"outside"},{"path":"~/gone","reason":"missing"}],
         "filters":[{"filter":"date","query":"budget type:pdf","count":12,"more":false},{"filter":"all","query":"budget","count":100,"more":true}],
         "suggestion":"budget plan","modes":[{"mode":"fuzzy","count":1,"more":false},{"mode":"other","count":3,"more":false}],
         "contentsOff":true,"unreadable":3,"indexing":true,"semanticPending":true}
        """#)
        let help = NoResultsHelp(d)
        XCTAssertEqual(help.items.map(\.text), [
            "~/Projects is not in the indexed folders.",
            "~/gone does not exist.",
            "12 results without the date filter.",
            "100+ results without filters.",
            "Did you mean “budget plan”?",
            "Fuzzy search finds 1 result.",
            "File contents are off: only names were searched.",
            "3 indexed files could not be read, so their text was not searched.",
            "Indexing is still running: results may be incomplete.",
            "Semantic indexing hasn't finished: only words were matched.",
        ])
        XCTAssertEqual(help.items[0].action, .settings)
        XCTAssertNil(help.items[1].action)
        XCTAssertEqual(help.items[2].button, "Remove Date Filter")
        XCTAssertEqual(help.items[2].action, .query("budget type:pdf"))
        XCTAssertEqual(help.items[3].button, "Remove All Filters")
        XCTAssertEqual(help.items[4].action, .query("budget plan"))
        XCTAssertEqual(help.items[5].action, .mode(.fuzzy))
    }

    func testRepliesWithoutDiagnosis() throws {
        let r = try reply(#"{"type":"diagnosis","id":2,"query":"budget","mode":"find"}"#)
        XCTAssertEqual(r.query, "budget")
        XCTAssertNil(r.diagnosis)
        XCTAssertEqual(NoResultsHelp(nil).items, [])
        XCTAssertEqual(NoResultsHelp(nil, indexing: true).items.map(\.text), ["Indexing is still running: results may be incomplete."])
    }

    func testQueriesLoseThePrefixTheAppAdded() throws {
        let d = try diagnosis(#"{"filters":[{"filter":"type","query":"semantic:lease","count":2,"more":false}],"suggestion":"semantic:lease"}"#)
        let help = NoResultsHelp(d, sentPrefix: "semantic:")
        XCTAssertEqual(help.items.map(\.action), [.query("lease"), .query("lease")])
        XCTAssertEqual(help.items[0].text, "2 results without the type filter.")
    }

    func testEncodesTheRequest() throws {
        let json = String(decoding: try Request.explain(query: "a b", mode: .fuzzy).encoded(id: 7), as: UTF8.self)
        XCTAssertEqual(json, #"{"id":7,"limit":200,"mode":"fuzzy","query":"a b","type":"explain"}"#)
    }

    func testExplainsOnlyTheEmptyResultOfTheQueryShown() throws {
        XCTAssertTrue(NoResultsHelp.shouldExplain(try response(query: "budget"), sentQuery: "budget", mode: .find))
        XCTAssertFalse(NoResultsHelp.shouldExplain(nil, sentQuery: "budget", mode: .find))
        // Results, an error, an older query or mode, or nothing typed: nothing to explain.
        XCTAssertFalse(NoResultsHelp.shouldExplain(try response(query: "budget", hits: 1), sentQuery: "budget", mode: .find))
        XCTAssertFalse(NoResultsHelp.shouldExplain(try response(query: "budget", error: "invalid regex"), sentQuery: "budget", mode: .find))
        XCTAssertFalse(NoResultsHelp.shouldExplain(try response(query: "budge"), sentQuery: "budget", mode: .find))
        XCTAssertFalse(NoResultsHelp.shouldExplain(try response(query: "budget"), sentQuery: "budget", mode: .fuzzy))
        XCTAssertFalse(NoResultsHelp.shouldExplain(try response(query: "  "), sentQuery: "  ", mode: .find))
    }

    func testRepliesForAnotherQueryAreNotShown() throws {
        let r = try reply(#"{"type":"diagnosis","id":3,"query":"budget","mode":"find","diagnosis":{"contentsOff":true}}"#)
        XCTAssertEqual(NoResultsHelp.current(r, sentQuery: "budget", mode: .find)?.contentsOff, true)
        XCTAssertNil(NoResultsHelp.current(r, sentQuery: "budget2", mode: .find))
        XCTAssertNil(NoResultsHelp.current(r, sentQuery: "budget", mode: .fuzzy))
        XCTAssertNil(NoResultsHelp.current(nil, sentQuery: "budget", mode: .find))
    }
}
