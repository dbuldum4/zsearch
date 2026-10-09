import Foundation
import XCTest
@testable import ZSearchKit

final class ProtocolTests: XCTestCase {
    /// Output recorded from `zsearch serve` (see Fixtures/serve-transcript.jsonl).
    func transcript() throws -> [Envelope] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "serve-transcript", withExtension: "jsonl", subdirectory: "Fixtures"))
        var splitter = LineSplitter()
        return try splitter.feed(Data(contentsOf: url)).map(Envelope.decode)
    }

    func testDecodesEveryRecordedMessage() throws {
        let messages = try transcript()
        XCTAssertFalse(messages.isEmpty)
        for m in messages {
            if case let .unknown(type) = m.message { XCTFail("unknown message type \(type)") }
        }

        guard case let .ready(ready) = messages[0].message else { return XCTFail("first message should be ready") }
        XCTAssertTrue(ready.firstRun)
        XCTAssertEqual(ready.config.roots, ["~/Documents", "~/Downloads"])
        XCTAssertEqual(ready.config.autoRefreshMinutes, 60)

        let results = messages.compactMap { m -> SearchResponse? in
            if case let .results(r) = m.message { return r }
            return nil
        }
        let hit = try XCTUnwrap(results.first?.hits.first)
        XCTAssertEqual(hit.name, "menu.txt")
        XCTAssertEqual(hit.folder, "Documents")
        XCTAssertEqual(hit.lines.first?.ranges, [[5, 14]])

        let preview = try XCTUnwrap(messages.compactMap { m -> FilePreview? in
            if case let .preview(p) = m.message { return p }
            return nil
        }.first)
        XCTAssertEqual(preview.focusLine, 2)
        XCTAssertNil(preview.note)

        XCTAssertTrue(messages.contains { m in
            if case .indexDone(let d) = m.message { return d.status == "done" && d.progress?.added == 1 }
            return false
        })
        XCTAssertTrue(messages.contains { $0.id == 5 && $0.message == .error("unknown request type \"nope\"") })
    }

    func testEncodesRequests() throws {
        func json(_ r: Request) throws -> String { String(decoding: try r.encoded(id: 7), as: UTF8.self) }
        XCTAssertEqual(try json(.search(query: "a/b", mode: .fuzzy, limit: 5)), #"{"id":7,"limit":5,"mode":"fuzzy","query":"a/b","type":"search"}"#)
        XCTAssertEqual(try json(.preview(file: 3, query: "x", mode: .find)), #"{"file":3,"id":7,"mode":"find","query":"x","type":"preview"}"#)
        XCTAssertEqual(try json(.setConfig(ConfigPatch(roots: ["~"]))), #"{"config":{"roots":["~"]},"id":7,"type":"setConfig"}"#)
        XCTAssertEqual(try json(.index), #"{"id":7,"type":"index"}"#)
        XCTAssertEqual(try json(.rebuildIndex), #"{"id":7,"rebuild":true,"type":"index"}"#)
        XCTAssertEqual(try json(.previews(files: [1, 2], query: "q", mode: .find)), #"{"files":[1,2],"id":7,"mode":"find","query":"q","type":"previews"}"#)
        let patch = try XCTUnwrap(try transcript().compactMap { m -> Config? in
            if case let .ready(r) = m.message { return r.config }
            return nil
        }.first)
        XCTAssertTrue(patch.respectGitignore)
        XCTAssertEqual(patch.exclude, [])
    }

    func testUnknownMessageTypesAreKept() throws {
        let e = try Envelope.decode(Data(#"{"type":"somethingNew","x":1}"#.utf8))
        XCTAssertNil(e.id)
        XCTAssertEqual(e.message, .unknown(type: "somethingNew"))
    }

    func testLineSplitterKeepsPartialLines() {
        var s = LineSplitter()
        XCTAssertEqual(s.feed(Data("{\"a\":1}\n{\"b\"".utf8)).map { String(decoding: $0, as: UTF8.self) }, [#"{"a":1}"#])
        XCTAssertEqual(s.feed(Data(":2}\n\n".utf8)).map { String(decoding: $0, as: UTF8.self) }, [#"{"b":2}"#])
        XCTAssertEqual(s.feed(Data()), [])
    }

    func testHighlightUsesUTF16Offsets() {
        // "é" is one UTF-16 unit, "😀" is two: JavaScript offsets count UTF-16 units.
        XCTAssertEqual(highlightRuns("café 😀 tea", ranges: [[8, 11]]), [TextRun("café 😀 ", highlighted: false), TextRun("tea", highlighted: true)])
        XCTAssertEqual(highlightRuns("abcdef", ranges: [[4, 9], [0, 2], [1, 3]]), [
            TextRun("ab", highlighted: true), TextRun("c", highlighted: true), TextRun("d", highlighted: false), TextRun("ef", highlighted: true),
        ])
        XCTAssertEqual(highlightRuns("", ranges: [[0, 1]]), [])
        XCTAssertEqual(kindBadge("sheet"), "XLS")
        XCTAssertEqual(kindBadge("whatever"), "FILE")
    }

    func testAutoUpdateIsDueOncePerPeriod() {
        let hour = 3_600_000.0
        let now = 100 * hour
        // Never indexed, or older than the period.
        XCTAssertTrue(AutoUpdate.isDue(minutes: 60, lastIndexedAt: nil, now: now))
        XCTAssertTrue(AutoUpdate.isDue(minutes: 60, lastIndexedAt: now - 2 * hour, now: now))
        XCTAssertFalse(AutoUpdate.isDue(minutes: 60, lastIndexedAt: now - hour / 2, now: now))
        XCTAssertTrue(AutoUpdate.isDue(minutes: 15, lastIndexedAt: now - hour / 2, now: now))
        // "Only when I ask".
        XCTAssertFalse(AutoUpdate.isDue(minutes: 0, lastIndexedAt: nil, now: now))
        // A failed attempt is not retried at every check.
        XCTAssertFalse(AutoUpdate.isDue(minutes: 60, lastIndexedAt: now - 2 * hour, lastAttempt: now - 60_000, now: now))
        XCTAssertTrue(AutoUpdate.isDue(minutes: 60, lastIndexedAt: now - 2 * hour, lastAttempt: now - hour, now: now))
    }
}
