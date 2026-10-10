import XCTest
@testable import ZSearchKit

final class EditorTests: XCTestCase {
    func testArguments() {
        let code = EditorApp.known.first { $0.name == "Visual Studio Code" }!
        XCTAssertEqual(code.arguments(path: "/a/b.ts", line: 12), ["-g", "/a/b.ts:12"])
        XCTAssertEqual(code.arguments(path: "/a/b.ts", line: nil), ["/a/b.ts"])
        let zed = EditorApp.known.first { $0.name == "Zed" }!
        XCTAssertEqual(zed.arguments(path: "/a/b.rs", line: 3), ["/a/b.rs:3"])
        let xcode = EditorApp.known.first { $0.name == "Xcode" }!
        XCTAssertEqual(xcode.arguments(path: "/a/b.swift", line: 7), ["-l", "7", "/a/b.swift"])
        XCTAssertEqual(xcode.arguments(path: "/a/b.swift", line: 0), ["/a/b.swift"])
    }

    func testToolPath() {
        let bundle = URL(fileURLWithPath: "/Applications/Zed.app")
        XCTAssertEqual(EditorApp.known.first { $0.name == "Zed" }!.toolPath(bundle: bundle), "/Applications/Zed.app/Contents/MacOS/cli")
        XCTAssertEqual(EditorApp.known.first { $0.name == "Xcode" }!.toolPath(bundle: bundle), "/usr/bin/xed")
    }

    func testWhatOpensInTheEditor() {
        XCTAssertTrue(EditorApp.edits(kind: "code", isDir: false))
        XCTAssertTrue(EditorApp.edits(kind: "folder", isDir: true))
        XCTAssertFalse(EditorApp.edits(kind: "app", isDir: true))
        XCTAssertFalse(EditorApp.edits(kind: "pdf", isDir: false))
        XCTAssertFalse(EditorApp.edits(kind: "image", isDir: false))
    }
}
