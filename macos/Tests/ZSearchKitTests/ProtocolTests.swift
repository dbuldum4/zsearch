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
        XCTAssertEqual(try json(.backgroundIndex), #"{"background":true,"id":7,"type":"index"}"#)
        XCTAssertEqual(try json(.estimate(roots: ["~/Documents"])), #"{"id":7,"roots":["~/Documents"],"type":"estimate"}"#)
        XCTAssertEqual(try json(.previews(files: [1, 2], query: "q", mode: .find)), #"{"files":[1,2],"id":7,"mode":"find","query":"q","type":"previews"}"#)
        XCTAssertEqual(
            try json(.previews(files: [1, 2], query: "q", mode: .find, focusLines: [551, nil])),
            #"{"files":[1,2],"focusLines":[551,null],"id":7,"mode":"find","query":"q","type":"previews"}"#
        )
        let patch = try XCTUnwrap(try transcript().compactMap { m -> Config? in
            if case let .ready(r) = m.message { return r.config }
            return nil
        }.first)
        XCTAssertTrue(patch.respectGitignore)
        XCTAssertEqual(patch.exclude, [])
    }

    func testDecodesEstimatesAndWaitingProgress() throws {
        let folder = #"{"root":"~","files":1200,"folders":30,"textFiles":900,"textBytes":4096,"documents":40,"ocrImages":0,"complete":false,"seconds":75.5}"#
        let e = try Envelope.decode(Data(#"{"id":3,"type":"estimate","estimates":[\#(folder)],"total":\#(folder),"text":"over 1,200 files · a minute or more"}"#.utf8))
        guard case let .estimate(reply) = e.message else { return XCTFail("expected an estimate") }
        XCTAssertEqual(reply.total.files, 1200)
        XCTAssertFalse(reply.estimates[0].complete)
        XCTAssertEqual(reply.text, "over 1,200 files · a minute or more")

        let progress = #"{"type":"indexProgress","progress":{"phase":"content","scanned":5,"added":5,"updated":0,"removed":0,"contentTotal":5,"contentDone":1,"contentBytes":0,"contentErrors":0,"waiting":"Low Power Mode","current":"","elapsedMs":10}}"#
        guard case let .indexProgress(p) = try Envelope.decode(Data(progress.utf8)).message else { return XCTFail("expected progress") }
        XCTAssertEqual(p.waiting, "Low Power Mode")
    }

    func testSemanticRequestsAndReplies() throws {
        func json(_ r: Request) throws -> String { String(decoding: try r.encoded(id: 7), as: UTF8.self) }
        XCTAssertEqual(try json(.search(query: "red car", mode: .semantic)), #"{"id":7,"limit":200,"mode":"semantic","query":"red car","type":"search"}"#)
        XCTAssertEqual(try json(.semanticInstall(images: false)), #"{"id":7,"images":false,"type":"semanticInstall"}"#)
        XCTAssertEqual(try json(.semanticRemove), #"{"id":7,"type":"semanticRemove"}"#)
        XCTAssertEqual(
            try json(.setConfig(ConfigPatch(semantic: SemanticConfig(enabled: true, images: true, code: false)))),
            #"{"config":{"semantic":{"code":false,"enabled":true,"images":true}},"id":7,"type":"setConfig"}"#
        )
        let status = #"{"id":2,"type":"semantic","status":{"enabled":true,"images":true,"code":false,"helper":"/x/zsearch-embed","modelDir":"/m","model":{"text":true,"media":false,"textBytes":309855456,"mediaBytes":554821024},"blocked":null,"index":{"files":3,"passages":9,"vectors":8,"partial":0,"bytes":4096,"lastRunAt":1700000000000,"error":null}}}"#
        guard case let .semantic(s) = try Envelope.decode(Data(status.utf8)).message else { return XCTFail("expected a status") }
        XCTAssertTrue(s.model.text)
        XCTAssertEqual(s.index?.vectors, 8)
        let download = #"{"type":"semanticDownload","file":"embeddinggemma-2-Q8_0.gguf","received":10,"total":20}"#
        guard case let .semanticDownload(d) = try Envelope.decode(Data(download.utf8)).message else { return XCTFail("expected progress") }
        XCTAssertEqual(d.received, 10)
        let meaning = #"{"type":"indexProgress","progress":{"phase":"meaning","scanned":5,"added":0,"updated":0,"removed":0,"contentTotal":0,"contentDone":0,"contentBytes":0,"contentErrors":0,"current":"","elapsedMs":10,"meaning":{"total":4,"done":1,"embedded":7,"reused":2}}}"#
        guard case let .indexProgress(p) = try Envelope.decode(Data(meaning.utf8)).message else { return XCTFail("expected progress") }
        XCTAssertEqual(p.fraction, 0.25)
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
