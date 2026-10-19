import XCTest
@testable import ZSearchKit

final class IndexLogTests: XCTestCase {
    private func progress(_ phase: String, current: String = "", done: Int = 0, total: Int = 0, errors: Int = 0, waiting: String? = nil, meaning: String? = nil, partial: Bool = false) throws -> IndexProgress {
        try JSONDecoder().decode(IndexProgress.self, from: Data("""
        {"phase":"\(phase)","scanned":10,"added":0,"updated":0,"removed":0,"contentTotal":\(total),"contentDone":\(done),"contentBytes":0,
         "contentErrors":\(errors),"current":"\(current)","elapsedMs":1,"partial":\(partial)\(waiting.map { #","waiting":""# + $0 + #"""# } ?? "")\(meaning.map { #","meaning":"# + $0 } ?? "")}
        """.utf8))
    }

    func testLogsPhasesFilesWaitsAndErrors() throws {
        var log = IndexLog(home: "/Users/me")
        log.record(try progress("scan", current: "/Users/me/Documents"))
        log.record(try progress("content", current: "/Users/me/Downloads/a.pdf", total: 9))
        // The same file again: no new line.
        log.record(try progress("content", current: "/Users/me/Downloads/a.pdf", done: 1, total: 9))
        log.record(try progress("content", current: "/Volumes/X/b.mp4", done: 2, total: 9, errors: 1))
        log.record(try progress("content", current: "/Volumes/X/b.mp4", done: 2, total: 9, errors: 1, waiting: "on battery"))
        log.record(try progress("content", current: "/Volumes/X/b.mp4", done: 3, total: 9, errors: 3))
        log.record(try progress("meaning", meaning: #"{"total":1,"done":0,"embedded":0,"reused":0}"#))
        log.finished("done")
        XCTAssertEqual(log.lines.map(\.text), [
            "Scanning folders",
            "~/Documents",
            "Extracting text: 9 files to read",
            "~/Downloads/a.pdf",
            "1 file could not be read",
            "/Volumes/X/b.mp4",
            "Waiting: on battery",
            "Resumed",
            "3 files could not be read",
            "Building the semantic index: 1 file",
            "Finished",
        ])
    }

    func testAnUpdateOfChangedFilesAndEndings() throws {
        var log = IndexLog(home: "/Users/me")
        log.record(try progress("scan", partial: true))
        log.finished("cancelled")
        // A new run starts its phases over.
        log.record(try progress("scan"))
        log.finished("error", error: "disk full")
        log.finished("locked")
        XCTAssertEqual(log.lines.map(\.text), ["Checking changed files", "Stopped", "Scanning folders", "Failed: disk full", "Another zsearch process is updating the index"])
    }

    func testKeepsTheNewestLines() {
        var log = IndexLog(limit: 3)
        for n in 1...5 { log.note("line \(n)") }
        XCTAssertEqual(log.lines.map(\.text), ["line 3", "line 4", "line 5"])
        XCTAssertEqual(log.lines.map(\.id), [2, 3, 4])
    }

    func testTextHasTimes() {
        var log = IndexLog()
        log.note("Scanning folders", at: Date(timeIntervalSince1970: 3661))
        XCTAssertEqual(log.text(timeZone: TimeZone(identifier: "UTC")!), "01:01:01  Scanning folders")
    }
}
