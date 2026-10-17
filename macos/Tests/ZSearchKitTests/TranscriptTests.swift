import Foundation
import XCTest
@testable import ZSearchKit

final class TranscriptTests: XCTestCase {
    func testReadsTheStampEachSegmentStartsWith() throws {
        let stamp = try XCTUnwrap(Transcript.stamp(in: "[00:01:23] Orion telescope budget approved"))
        XCTAssertEqual(stamp.seconds, 83)
        XCTAssertEqual(stamp.range, NSRange(location: 0, length: 10))
        XCTAssertEqual(Transcript.stamp(in: "[01:02:05] later")?.seconds, 3725)
        XCTAssertEqual(Transcript.stamp(in: "[100:00:00] past the helper's two hours")?.seconds, 360_000)
        // A character limit can leave a stamp with no words after it.
        XCTAssertEqual(Transcript.stamp(in: "[00:00:05]")?.seconds, 5)
        // Ranges are UTF-16, as NSString counts them, whatever the words after.
        XCTAssertEqual(Transcript.stamp(in: "[00:00:01] 👋 café")?.range, NSRange(location: 0, length: 10))
    }

    func testRejectsCutAndMalformedStamps() {
        for line in ["", "[", "[00:0", "[00:01:2", "[00:01:23", "[0:01:23] one-digit hours", "[00:1:23] x",
                     "[00:60:00] x", "[00:00:60] x", "[00:01:23]words", "x [00:01:23] later in the line",
                     "…budget approved", "[aa:bb:cc] x", "(00:01:23) x"] {
            XCTAssertNil(Transcript.stamp(in: line), line)
        }
    }

    func testFormatsAsTranscriptsStamp() {
        XCTAssertEqual(Transcript.format(0), "00:00:00")
        XCTAssertEqual(Transcript.format(83.5), "00:01:23")
        XCTAssertEqual(Transcript.format(3725.9), "01:02:05")
        XCTAssertEqual(Transcript.format(-4), "00:00:00")
        XCTAssertEqual(Transcript.format(.nan), "00:00:00")
    }

    func testSeekLinksRoundTrip() throws {
        let url = Transcript.seekURL(3725)
        XCTAssertEqual(Transcript.seconds(from: url), 3725)
        XCTAssertNil(Transcript.seconds(from: try XCTUnwrap(URL(string: "https://example.com/01:02:05"))))
        XCTAssertNil(Transcript.seconds(from: try XCTUnwrap(URL(string: "zsearch-seek:soon"))))
    }

    private func hit(kind: String, lines: String) throws -> SearchHit {
        let json = #"{"id":1,"path":"/r/talk.m4a","display":"~/r/talk.m4a","kind":"\#(kind)","isDir":false,"size":1,"mtime":0,"score":1,"sources":["content"],"namePositions":[],"lines":\#(lines),"matchCount":1}"#
        return try JSONDecoder().decode(SearchHit.self, from: Data(json.utf8))
    }

    func testBestMatchOfARecordingHit() throws {
        // A clipped snippet line has lost its stamp: the engine's start is used.
        let clipped = try hit(kind: "audio", lines: #"[{"line":2,"page":1,"text":"…the quasar results","ranges":[[4,10]],"startSeconds":3725}]"#)
        XCTAssertEqual(Transcript.start(of: clipped), 3725)
        let whole = try hit(kind: "video", lines: #"[{"line":1,"page":1,"text":"[00:00:07] the quasar","ranges":[[15,21]]}]"#)
        XCTAssertEqual(Transcript.start(of: whole), 7)
        XCTAssertNil(Transcript.start(of: try hit(kind: "text", lines: #"[{"line":1,"page":1,"text":"[00:00:07] notes","ranges":[]}]"#)))
        XCTAssertNil(Transcript.start(of: try hit(kind: "audio", lines: "[]")))
    }

    func testFocusedMatchOfARecordingPreview() throws {
        func preview(focus: Int, matches: [Int]) throws -> FilePreview {
            let json = #"{"id":1,"path":"/r/talk.m4a","display":"~/r/talk.m4a","kind":"audio","isDir":false,"size":1,"mtime":0,"lines":[{"n":1,"text":"[00:00:03] Opening remarks","ranges":[]},{"n":2,"text":"[01:02:05] the quasar results","ranges":[[15,21]]}],"totalLines":2,"focusLine":\#(focus),"pageStarts":[],"matchLines":\#(matches),"source":"index"}"#
            return try JSONDecoder().decode(FilePreview.self, from: Data(json.utf8))
        }
        XCTAssertEqual(Transcript.start(of: try preview(focus: 2, matches: [2])), 3725)
        // Without a match in focus there is no moment to play from.
        XCTAssertNil(Transcript.start(of: try preview(focus: 1, matches: [])))
    }
}
