import XCTest
@testable import ZSearchKit

final class SetupTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func stats(indexed: Bool = true, semantic: String? = #"{"files":10,"current":10,"pending":0}"#) throws -> IndexStats {
        try decode(IndexStats.self, """
        {"files":12,"folders":2,"withContent":10,"errors":0,"skipped":0,"pending":0,"contentBytes":100,"dbBytes":1000,
         "lastIndexedAt":\(indexed ? "1700000000000" : "null"),"lastDurationMs":5,"roots":["~/Documents"]\(semantic.map { #","semantic":"# + $0 } ?? "")}
        """)
    }

    private func semantic(enabled: Bool = true, ready: Bool = true, helper: Bool = true) throws -> SemanticStatus {
        try decode(SemanticStatus.self, """
        {"enabled":\(enabled),"declined":false,"code":false,"helper":\(helper ? #""/x/zsearch-embed""# : "null"),"modelDir":"/m",
         "model":{"ready":\(ready),"bytes":1},"blocked":null,"index":null}
        """)
    }

    private func done(status: String = "done", partial: Bool = false, meaning: String? = #"{"total":5,"done":5,"embedded":5,"reused":0}"#) throws -> IndexDone {
        try decode(IndexDone.self, """
        {"status":"\(status)","progress":{"phase":"meaning","scanned":12,"added":12,"updated":0,"removed":0,"contentTotal":10,"contentDone":10,
         "contentBytes":100,"contentErrors":0,"current":"","elapsedMs":10,"partial":\(partial)\(meaning.map { #","meaning":"# + $0 } ?? "")}}
        """)
    }

    func testReadyOnceEveryFileHasCurrentVectors() throws {
        XCTAssertTrue(SetupGate.isReady(stats: try stats(), semantic: try semantic(), contentsOn: true, indexing: false))
        // Still indexing, never indexed, files pending, or not yet known: not yet.
        XCTAssertFalse(SetupGate.isReady(stats: try stats(), semantic: try semantic(), contentsOn: true, indexing: true))
        XCTAssertFalse(SetupGate.isReady(stats: try stats(indexed: false), semantic: try semantic(), contentsOn: true, indexing: false))
        XCTAssertFalse(SetupGate.isReady(stats: try stats(semantic: #"{"files":10,"current":9,"pending":1}"#), semantic: try semantic(), contentsOn: true, indexing: false))
        XCTAssertFalse(SetupGate.isReady(stats: nil, semantic: try semantic(), contentsOn: true, indexing: false))
        XCTAssertFalse(SetupGate.isReady(stats: try stats(), semantic: nil, contentsOn: true, indexing: false))
        // The model still downloading, or semantic search not on yet.
        XCTAssertFalse(SetupGate.isReady(stats: try stats(semantic: nil), semantic: try semantic(ready: false), contentsOn: true, indexing: false))
        XCTAssertFalse(SetupGate.isReady(stats: try stats(semantic: nil), semantic: try semantic(enabled: false), contentsOn: true, indexing: false))
    }

    func testWithoutSemanticSearchTheWordIndexIsEnough() throws {
        XCTAssertTrue(SetupGate.isReady(stats: try stats(semantic: nil), semantic: try semantic(ready: false, helper: false), contentsOn: true, indexing: false))
        XCTAssertTrue(SetupGate.isReady(stats: try stats(semantic: nil), semantic: try semantic(), contentsOn: false, indexing: false))
        XCTAssertFalse(SetupGate.isReady(stats: try stats(indexed: false, semantic: nil), semantic: try semantic(helper: false), contentsOn: true, indexing: false))
    }

    func testAWholeRunWithACompleteSemanticPassCompletesSetup() throws {
        XCTAssertTrue(SetupGate.completes(try done(), semantic: try semantic()))
        // A file left pending (Granite could not embed it) does not hold setup up.
        XCTAssertTrue(SetupGate.completes(try done(meaning: #"{"total":5,"done":6,"embedded":5,"reused":1}"#), semantic: try semantic()))
        XCTAssertFalse(SetupGate.completes(try done(status: "cancelled"), semantic: try semantic()))
        XCTAssertFalse(SetupGate.completes(try done(partial: true), semantic: try semantic()))
        XCTAssertFalse(SetupGate.completes(try done(meaning: nil), semantic: try semantic()))
        XCTAssertFalse(SetupGate.completes(try done(meaning: #"{"total":5,"done":3,"embedded":3,"reused":0}"#), semantic: try semantic()))
        XCTAssertFalse(SetupGate.completes(try done(meaning: #"{"total":5,"done":5,"embedded":5,"reused":0,"error":"helper crashed"}"#), semantic: try semantic()))
        XCTAssertFalse(SetupGate.completes(try done(), semantic: try semantic(ready: false)))
    }

    func testRemainingTimeFollowsThePaceOfThePhase() {
        var t = RemainingTime()
        XCTAssertNil(t.update(phase: "content", done: 0, total: 1000, now: 0))
        // Too soon to tell.
        XCTAssertNil(t.update(phase: "content", done: 50, total: 1000, now: 5))
        // 200 files in 20 s: 800 more take 80 s.
        XCTAssertEqual(t.update(phase: "content", done: 200, total: 1000, now: 20)!, 80, accuracy: 0.001)
        XCTAssertEqual(t.update(phase: "content", done: 1000, total: 1000, now: 100), 0)
        // A new phase starts over.
        XCTAssertNil(t.update(phase: "meaning", done: 0, total: 500, now: 101))
        XCTAssertNil(t.update(phase: "meaning", done: 0, total: 500, now: 120))
        XCTAssertEqual(t.update(phase: "meaning", done: 100, total: 500, now: 141)!, 160, accuracy: 0.001)
        // So does a count that went back: another run.
        XCTAssertNil(t.update(phase: "meaning", done: 10, total: 500, now: 150))
    }

    func testRemainingTimeText() {
        XCTAssertEqual(RemainingTime.text(30), "Less than a minute left")
        XCTAssertEqual(RemainingTime.text(61), "About 2 minutes left")
        XCTAssertEqual(RemainingTime.text(60), "About a minute left")
        XCTAssertEqual(RemainingTime.text(45 * 60), "About 45 minutes left")
        XCTAssertEqual(RemainingTime.text(70 * 60), "About an hour left")
        XCTAssertEqual(RemainingTime.text(5 * 3600), "About 5 hours left")
    }
}
