import Foundation
import XCTest
@testable import ZSearchKit

final class SyntaxHighlightTests: XCTestCase {
    /// The text and kind of each token on each line.
    func colored(_ path: String, _ lines: [String]) throws -> [[String]] {
        var h = SyntaxHighlighter(language: try XCTUnwrap(SyntaxLanguage.forPath(path)))
        return lines.map { line in
            let u = Array(line.utf16)
            return h.tokens(line).map { "\($0.kind):" + String(decoding: u[$0.start..<$0.end], as: UTF16.self) }
        }
    }

    func testOnlyCodeIsHighlighted() {
        XCTAssertNotNil(SyntaxLanguage.forPath("/a/b/main.swift"))
        XCTAssertNotNil(SyntaxLanguage.forPath("/a/App.TSX"))
        XCTAssertNotNil(SyntaxLanguage.forPath("/a/Dockerfile"))
        XCTAssertNil(SyntaxLanguage.forPath("/a/notes.txt"))
        XCTAssertNil(SyntaxLanguage.forPath("/a/paper.pdf"))
        XCTAssertNil(SyntaxLanguage.forPath("/a/README.md"))
        XCTAssertNil(SyntaxLanguage.forPath("/a/report.docx"))
        XCTAssertNil(SyntaxLanguage.forPath("/a/no-extension"))
    }

    func testSwift() throws {
        XCTAssertEqual(try colored("x.swift", [
            "@MainActor final class Model { // the model",
            "    let n = 42, s = \"a \\\" b\"",
            "    x.default = .init",
        ]), [
            ["meta:@MainActor", "keyword:final", "keyword:class", "type:Model", "comment:// the model"],
            ["keyword:let", "number:42", "string:\"a \\\" b\""],
            [],
        ])
    }

    func testBlockCommentsAndStringsSpanLines() throws {
        XCTAssertEqual(try colored("x.ts", [
            "const a = 1 /* start",
            "still a comment */ let b = `x",
            "y` + 'z'",
        ]), [
            ["keyword:const", "number:1", "comment:/* start"],
            ["comment:still a comment */", "keyword:let", "string:`x"],
            ["string:y`", "string:'z'"],
        ])
        XCTAssertEqual(try colored("x.py", ["def f():", "    \"\"\"Doc", "    more\"\"\" # done"]), [
            ["keyword:def"], ["string:\"\"\"Doc"], ["string:    more\"\"\"", "comment:# done"],
        ])
    }

    func testApostrophesAreNotStrings() throws {
        XCTAssertEqual(try colored("x.rs", ["fn f<'a>(c: char) -> &'a str { 'x' }"]), [
            ["keyword:fn", "type:char", "type:str", "string:'x'"],
        ])
        XCTAssertEqual(try colored("x.yaml", ["name: don't panic # ok", "q: 'quoted'"]), [
            ["comment:# ok"], ["string:'quoted'"],
        ])
    }

    func testCPreprocessorAndSQL() throws {
        XCTAssertEqual(try colored("x.c", ["#include <stdio.h> // io", "int x = 0x1F;"]), [
            ["meta:#include <stdio.h> ", "comment:// io"], ["type:int", "number:0x1F"],
        ])
        XCTAssertEqual(try colored("x.sql", ["SELECT id FROM t -- all"]), [
            ["keyword:SELECT", "keyword:FROM", "comment:-- all"],
        ])
    }

    func testMarkupLeavesTextAlone() throws {
        XCTAssertEqual(try colored("x.html", ["<a href=\"/\">it's</a> <!-- c", "c --> <br>"]), [
            ["meta:a", "type:href", "string:\"/\"", "meta:a", "comment:<!-- c"],
            ["comment:c -->", "meta:br"],
        ])
    }

    func testOffsetsAreUTF16() throws {
        let line = "let 🙂 = \"é\""
        var h = SyntaxHighlighter(language: try XCTUnwrap(SyntaxLanguage.forPath("x.swift")))
        let s = try XCTUnwrap(h.tokens(line).last)
        XCTAssertEqual(s.kind, .string)
        XCTAssertEqual(s.end, (line as NSString).length)
    }
}
