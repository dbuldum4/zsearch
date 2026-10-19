import Foundation
import XCTest
@testable import ZSearchKit

final class QuickLookPreviewTests: XCTestCase {
    private func preview(kind: String, ext: String) throws -> FilePreview {
        // Both previews have indexed text: that used to prevent a visual Office preview.
        let json = #"{"id":1,"path":"/docs/budget.\#(ext)","display":"budget.\#(ext)","kind":"\#(kind)","isDir":false,"size":100,"mtime":0,"lines":[{"n":1,"text":"Budget","ranges":[[0,6]]}],"totalLines":1,"focusLine":1,"pageStarts":[1],"matchLines":[1],"source":"index"}"#
        return try JSONDecoder().decode(FilePreview.self, from: Data(json.utf8))
    }

    func testIndexedOfficeFilesShowLayoutAndCanSwitchToText() throws {
        for (kind, ext) in [("sheet", "xlsx"), ("slides", "pptx")] {
            let p = try preview(kind: kind, ext: ext)
            XCTAssertTrue(QuickLookPreview.isOffice(p))
            XCTAssertTrue(QuickLookPreview.showsFile(p, showsText: false))
            XCTAssertFalse(QuickLookPreview.showsFile(p, showsText: true))
        }
    }

    func testOfficeFilesWithoutTextStillShowAndRespectContentPolicy() throws {
        for (kind, ext) in [("sheet", "xlsx"), ("slides", "pptx")] {
            var p = try preview(kind: kind, ext: ext)
            p.lines = []
            p.message = "No text found"
            XCTAssertTrue(QuickLookPreview.showsFile(p, showsText: true))
            p.contentAllowed = false
            XCTAssertFalse(QuickLookPreview.handles(p))
            XCTAssertFalse(QuickLookPreview.showsFile(p, showsText: false))
            p.contentAllowed = true
            p.isDir = true
            XCTAssertFalse(QuickLookPreview.handles(p))
        }
    }

    func testExistingVisualKindsAndTextFallback() throws {
        for kind in ["image", "video", "audio", "font"] {
            let p = try preview(kind: kind, ext: "file")
            XCTAssertFalse(QuickLookPreview.isOffice(p))
            XCTAssertTrue(QuickLookPreview.showsFile(p, showsText: false))
            XCTAssertFalse(QuickLookPreview.showsFile(p, showsText: true))
        }
        var p = try preview(kind: "text", ext: "txt")
        XCTAssertFalse(QuickLookPreview.handles(p))
        p.message = "No text found"
        XCTAssertTrue(QuickLookPreview.handles(p))
    }
}
