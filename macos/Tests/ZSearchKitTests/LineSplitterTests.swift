import Foundation
import XCTest
@testable import ZSearchKit

final class LineSplitterTests: XCTestCase {
    private func strings(_ lines: [Data]) -> [String] {
        lines.map { String(decoding: $0, as: UTF8.self) }
    }

    func testSplitsLinesAcrossChunks() {
        var splitter = LineSplitter()
        XCTAssertEqual(strings(splitter.feed(Data("{\"a\":1}\n{\"b\"".utf8))), ["{\"a\":1}"])
        XCTAssertEqual(strings(splitter.feed(Data(":2".utf8))), [])
        XCTAssertEqual(strings(splitter.feed(Data("}\n\n{\"c\":3}\n{".utf8))), ["{\"b\":2}", "{\"c\":3}"])
        XCTAssertEqual(strings(splitter.feed(Data("}\n".utf8))), ["{}"])
    }

    func testLongLineInManySmallChunks() {
        var splitter = LineSplitter()
        let chunk = Data(repeating: UInt8(ascii: "x"), count: 4096)
        for _ in 0..<1024 {
            XCTAssertEqual(splitter.feed(chunk), [])
        }
        let lines = splitter.feed(Data("\nnext\n".utf8))
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(lines[0].count, 4096 * 1024)
        XCTAssertEqual(strings([lines[1]]), ["next"])
    }
}
