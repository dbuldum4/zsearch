import Foundation
import XCTest
@testable import ZSearchKit

final class RelatedNavigationTests: XCTestCase {
    private func response(_ id: Int = 1) throws -> SearchResponse {
        let json = #"{"query":"harbour","mode":"find","resolved":"find","strategy":"exact","hits":[{"id":ID,"path":"/proposal-ID.md","display":"proposal-ID.md","kind":"markdown","isDir":false,"size":20,"mtime":10,"score":1,"sources":["content"],"namePositions":[],"lines":[{"line":3,"page":0,"text":"harbour","ranges":[]}],"matchCount":1}],"total":1,"elapsedMs":1,"partial":false}"#.replacingOccurrences(of: "ID", with: String(id))
        return try JSONDecoder().decode(SearchResponse.self, from: Data(json.utf8))
    }

    func testBackRestoresOriginalSearchAndPicksAfterFollowingSeveralSources() throws {
        let original = try response()
        var nav = RelatedNavigation()
        let ticket = nav.begin(original.hits[0], response: original, selection: ResultSelection(1))
        XCTAssertTrue(nav.loading)
        XCTAssertTrue(nav.finish(ticket))
        XCTAssertFalse(nav.loading)
        let other = try response(2)
        nav.begin(other.hits[0], response: other, selection: ResultSelection(2))
        let saved = nav.leave()
        XCTAssertEqual(saved?.response, original)
        XCTAssertEqual(saved?.selection.primary, 1)
        XCTAssertNil(nav.source)
        XCTAssertFalse(nav.accepts(ticket))
    }

    func testStaleRepliesCannotFinishAnotherSourceOrReenteredSource() throws {
        var nav = RelatedNavigation()
        let hit = try response().hits[0]
        let old = nav.begin(hit, response: nil, selection: ResultSelection())
        let refreshed = nav.begin(hit, response: nil, selection: ResultSelection())
        XCTAssertFalse(nav.finish(old))
        XCTAssertTrue(nav.loading)
        nav.leave()
        let reentered = nav.begin(hit, response: nil, selection: ResultSelection())
        XCTAssertFalse(nav.finish(refreshed))
        XCTAssertTrue(nav.finish(reentered))
        XCTAssertFalse(nav.loading)
    }

    func testRelatedProtocolKeepsSourceStateAndMatchingPassageFocus() throws {
        let encoded = try Request.related(file: "/a proposal.md", limit: 20, token: 4).encoded(id: 8)
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(fields["file"] as? String, "/a proposal.md")
        XCTAssertEqual(fields["token"] as? Int, 4)
        XCTAssertEqual(fields["type"] as? String, "related")
        let cancel = try Request.cancelRelated(token: 4).encoded(id: 9)
        XCTAssertTrue(String(decoding: cancel, as: UTF8.self).contains("cancelRelated"))
        let body = try response()
        let json = #"{"type":"related","id":8,"response":{"source":{"id":2,"path":"/source","display":"source","mtime":10},"status":"pending","query":"","mode":"semantic","resolved":"semantic","strategy":"related passages","hits":[],"total":0,"elapsedMs":1,"partial":false,"notice":"Source needs current vectors"}}"#
        guard case let .related(reply) = try Envelope.decode(Data(json.utf8)).message else { return XCTFail("expected related response") }
        XCTAssertEqual(reply.source?.path, "/source")
        XCTAssertEqual(reply.status, "pending")
        let preview = try Request.preview(file: body.hits[0].id, query: "", mode: .find, focusLine: body.hits[0].lines[0].line).encoded(id: 10)
        let previewFields = try XCTUnwrap(JSONSerialization.jsonObject(with: preview) as? [String: Any])
        XCTAssertEqual(previewFields["focusLine"] as? Int, 3)
        XCTAssertEqual(previewFields["query"] as? String, "")
    }
}
