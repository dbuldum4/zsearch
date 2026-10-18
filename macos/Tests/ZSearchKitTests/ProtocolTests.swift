import Foundation
import XCTest
@testable import ZSearchKit

final class ProtocolTests: XCTestCase {
    func testSpeechSettingsDecodeOlderEnginesAndEncodeOptOut() throws {
        let old = try JSONDecoder().decode(ContentConfig.self, from: Data(#"{"enabled":true}"#.utf8))
        XCTAssertNil(old.transcribe)
        XCTAssertNil(old.transcriptionLocale)
        let current = try JSONDecoder().decode(ContentConfig.self, from: Data(#"{"enabled":true,"transcribe":false,"transcriptionLocale":"tr-TR"}"#.utf8))
        XCTAssertEqual(current.transcribe, false)
        XCTAssertEqual(current.transcriptionLocale, "tr-TR")
        let request = Request.setConfig(ConfigPatch(content: ContentConfig(enabled: true, transcribe: false)))
        let data = try request.encoded(id: 1)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let patch = try XCTUnwrap(json["config"] as? [String: Any])
        let content = try XCTUnwrap(patch["content"] as? [String: Any])
        XCTAssertEqual(content["transcribe"] as? Bool, false)
        XCTAssertNil(content["transcriptionLocale"])
    }

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

    func testDuplicateGroups() throws {
        func json(_ r: Request) throws -> String { String(decoding: try r.encoded(id: 7), as: UTF8.self) }
        XCTAssertEqual(
            try json(.search(query: "q", mode: .find, groupDuplicates: true)),
            #"{"groupDuplicates":true,"id":7,"limit":200,"mode":"find","query":"q","type":"search"}"#
        )
        let fields = #""path":"/Users/me/Documents/a.pdf","display":"Documents/a.pdf","kind":"pdf","isDir":false,"size":10,"mtime":1700000000000,"score":1,"sources":["name"],"namePositions":[],"lines":[],"matchCount":0"#
        let copies = #""copies":[{"id":2,"path":"/Users/me/Downloads/a (1).pdf","display":"Downloads/a (1).pdf","mtime":1600000000000}],"copiesMore":true"#
        let hits = #"[{"id":1,\#(fields),\#(copies)},{"id":4,\#(fields)}]"#
        let line = #"{"id":3,"type":"results","response":{"query":"a","mode":"find","resolved":"find","strategy":"recent","hits":\#(hits),"total":2,"elapsedMs":1,"partial":false}}"#
        guard case let .results(r) = try Envelope.decode(Data(line.utf8)).message else { return XCTFail("expected results") }
        XCTAssertEqual(r.hits[0].copyCount, 2)
        XCTAssertEqual(r.hits[0].copiesMore, true)
        XCTAssertEqual(r.hits[0].copies?.first?.name, "a (1).pdf")
        XCTAssertEqual(r.hits[0].copies?.first?.folder, "Downloads")
        XCTAssertNil(r.hits[1].copies)
        XCTAssertEqual(r.hits[1].copyCount, 1)
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
        XCTAssertEqual(try json(.semanticInstall), #"{"id":7,"type":"semanticInstall"}"#)
        XCTAssertEqual(try json(.meaningIndex), #"{"id":7,"type":"meaningIndex"}"#)
        XCTAssertEqual(try json(.semanticRemove), #"{"id":7,"type":"semanticRemove"}"#)
        XCTAssertEqual(
            try json(.setConfig(ConfigPatch(semantic: SemanticConfig(enabled: true, declined: false, code: false)))),
            #"{"config":{"semantic":{"code":false,"declined":false,"enabled":true}},"id":7,"type":"setConfig"}"#
        )
        let status = #"{"id":2,"type":"semantic","status":{"enabled":true,"declined":false,"code":false,"helper":"/x/zsearch-embed","modelDir":"/m","model":{"ready":true,"bytes":52445632},"blocked":null,"index":{"files":3,"passages":9,"vectors":8,"partial":0,"bytes":4096,"lastRunAt":1700000000000,"error":null}}}"#
        guard case let .semantic(s) = try Envelope.decode(Data(status.utf8)).message else { return XCTFail("expected a status") }
        XCTAssertTrue(s.model.ready)
        XCTAssertEqual(s.model.bytes, 52445632)
        XCTAssertEqual(s.index?.vectors, 8)
        let download = #"{"type":"semanticDownload","file":"granite-embedding-small-english-r2.Q8_0.gguf","received":10,"total":20}"#
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
        XCTAssertTrue(AutoUpdate.isDue(minutes: 60, lastFullWalkAt: nil, now: now))
        XCTAssertTrue(AutoUpdate.isDue(minutes: 60, lastFullWalkAt: now - 2 * hour, now: now))
        XCTAssertFalse(AutoUpdate.isDue(minutes: 60, lastFullWalkAt: now - hour / 2, now: now))
        XCTAssertTrue(AutoUpdate.isDue(minutes: 15, lastFullWalkAt: now - hour / 2, now: now))
        // "Only when I ask".
        XCTAssertFalse(AutoUpdate.isDue(minutes: 0, lastFullWalkAt: nil, now: now))
        // A failed attempt is not retried at every check.
        XCTAssertFalse(AutoUpdate.isDue(minutes: 60, lastFullWalkAt: now - 2 * hour, lastAttempt: now - 60_000, now: now))
        XCTAssertTrue(AutoUpdate.isDue(minutes: 60, lastFullWalkAt: now - 2 * hour, lastAttempt: now - hour, now: now))
    }
}
