import Foundation
import XCTest
@testable import ZSearchKit

/// Runs the real engine. Set ZSEARCH_ENGINE to a `zsearch` binary (CI uses `bun run build`'s dist/zsearch).
final class EngineConnectionTests: XCTestCase {
    private final class Events: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [Message] = []
        private var didExit = false
        func add(_ m: Message) {
            lock.lock(); items.append(m); lock.unlock()
        }
        func exited() {
            lock.lock(); didExit = true; lock.unlock()
        }
        var hasExited: Bool {
            lock.lock(); defer { lock.unlock() }
            return didExit
        }
        var all: [Message] {
            lock.lock(); defer { lock.unlock() }
            return items
        }
    }

    func testIndexAndSearchWithTheRealEngine() async throws {
        guard let path = ProcessInfo.processInfo.environment["ZSEARCH_ENGINE"] else {
            throw XCTSkip("set ZSEARCH_ENGINE to a zsearch binary to run this test")
        }
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("zsearch-kit-\(UUID().uuidString)")
        let docs = home.appendingPathComponent("Documents")
        try FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        try "Shopping list\nThe marmalade is homemade.\n".write(to: docs.appendingPathComponent("list.txt"), atomically: true, encoding: .utf8)

        var env = ProcessInfo.processInfo.environment
        env["HOME"] = home.path
        env["ZSEARCH_HOME"] = home.appendingPathComponent(".zsearch").path
        let events = Events()
        let engine = EngineConnection(
            executable: URL(fileURLWithPath: path),
            environment: env,
            onEvent: { events.add($0) },
            onExit: { _ in events.exited() }
        )
        try engine.start()

        func waitFor(_ what: String, _ pred: (Message) -> Bool) async throws {
            for _ in 0..<300 {
                if events.all.contains(where: pred) { return }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            XCTFail("timed out waiting for \(what); got \(events.all)")
        }

        try await waitFor("ready") { if case .ready = $0 { return true }; return false }
        let ok = try await engine.request(.index)
        XCTAssertEqual(ok, .ok)
        try await waitFor("indexDone") { if case .indexDone = $0 { return true }; return false }

        guard case let .results(r) = try await engine.request(.search(query: "marmalade", mode: .find)) else {
            return XCTFail("expected results")
        }
        let hit = try XCTUnwrap(r.hits.first)
        XCTAssertEqual(hit.name, "list.txt")
        guard case let .preview(p) = try await engine.request(.preview(file: hit.id, query: "marmalade", mode: .find)) else {
            return XCTFail("expected a preview")
        }
        XCTAssertEqual(p.matchLines, [2])

        guard case let .previews(batch) = try await engine.request(.previews(files: [hit.id, 999_999], query: "marmalade", mode: .find)) else {
            return XCTFail("expected previews")
        }
        XCTAssertEqual(batch.map(\.id), [hit.id, 999_999])
        XCTAssertNotNil(batch[1].message)

        // Rebuild: empties the index in place, indexes again, and search still finds the file.
        let doneBefore = events.all.filter { if case .indexDone = $0 { return true }; return false }.count
        let rebuilding = try await engine.request(.rebuildIndex)
        XCTAssertEqual(rebuilding, .ok)
        try await waitFor("second indexDone") { _ in
            events.all.filter { if case .indexDone = $0 { return true }; return false }.count > doneBefore
        }
        guard case let .results(again) = try await engine.request(.search(query: "marmalade", mode: .find)) else {
            return XCTFail("expected results after rebuild")
        }
        XCTAssertEqual(again.hits.first?.name, "list.txt")

        do {
            _ = try await engine.request(.preview(file: 999_999, query: "", mode: .find))
        } catch {
            // Either an error or a preview with a message is fine; the connection must survive it.
        }
        guard case .stats = try await engine.request(.stats) else { return XCTFail("expected stats") }

        engine.stop()
        for _ in 0..<200 where !events.hasExited {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertTrue(events.hasExited, "the engine should exit when its input closes")
    }
}
