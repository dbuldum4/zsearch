import Foundation
import XCTest
@testable import ZSearchKit

final class NoResultsHelpTests: XCTestCase {
    func diagnosis(_ json: String) throws -> SearchDiagnosis? {
        let line = #"{"type":"results","id":1,"response":{"query":"q","mode":"find","resolved":"find","strategy":"","hits":[],"total":0,"elapsedMs":1,"partial":false,"diagnosis":"# + json + "}}"
        guard case let .results(r) = try Envelope.decode(Data(line.utf8)).message else {
            XCTFail("expected results")
            return nil
        }
        return r.diagnosis
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

    func testOlderEnginesAndResultsWithoutDiagnosis() throws {
        let line = #"{"type":"results","response":{"query":"q","mode":"find","resolved":"find","strategy":"","hits":[],"total":0,"elapsedMs":1,"partial":false}}"#
        guard case let .results(r) = try Envelope.decode(Data(line.utf8)).message else { return XCTFail("expected results") }
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
}
