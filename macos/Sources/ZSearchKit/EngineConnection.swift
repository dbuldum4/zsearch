import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#elseif canImport(Musl)
import Musl
#endif

public enum EngineError: Error, LocalizedError, Equatable {
    /// The engine exited; `stderr` holds the end of what it printed.
    case exited(status: Int32, stderr: String)
    /// The engine answered the request with an error.
    case failed(String)
    /// The engine sent a line the app could not read.
    case unreadable(String)

    public var errorDescription: String? {
        switch self {
        case let .exited(status, stderr):
            return "The zsearch engine stopped (exit status \(status))" + (stderr.isEmpty ? "." : ": \(stderr)")
        case let .failed(message):
            return message
        case let .unreadable(detail):
            return "Unexpected reply from the zsearch engine: \(detail)"
        }
    }
}

/// Runs `zsearch serve` as a child process and exchanges JSON lines with it.
///
/// `request` sends one request and waits for its reply. Messages without an `id` (index
/// progress, refreshes) go to `onEvent`. Both callbacks run on a background queue.
public final class EngineConnection: @unchecked Sendable {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private let lock = NSLock()
    private let writeLock = NSLock()
    private var splitter = LineSplitter()
    private var nextID = 0
    private var waiting: [Int: CheckedContinuation<Message, Error>] = [:]
    private var stderrTail = Data()
    private var exitStatus: Int32?
    private let onEvent: @Sendable (Message) -> Void
    private let onExit: @Sendable (EngineError) -> Void

    public init(
        executable: URL,
        arguments: [String] = ["serve"],
        environment: [String: String]? = nil,
        onEvent: @escaping @Sendable (Message) -> Void,
        onExit: @escaping @Sendable (EngineError) -> Void
    ) {
        process.executableURL = executable
        process.arguments = arguments
        if let environment { process.environment = environment }
        self.onEvent = onEvent
        self.onExit = onExit
    }

    public var isRunning: Bool { process.isRunning }

    public func start() throws {
        // A write to an engine that just exited must fail with an error, not kill the app.
        signal(SIGPIPE, SIG_IGN)
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            self?.receive(data)
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            self?.keepStderr(data)
        }
        process.terminationHandler = { [weak self] p in
            self?.terminated(p.terminationStatus)
        }
        try process.run()
    }

    /// Send a request and wait for its reply. Throws `EngineError.failed` if the engine answers with an error.
    public func request(_ request: Request) async throws -> Message {
        let reply: Message = try await withCheckedThrowingContinuation { cont in
            lock.lock()
            if let status = exitStatus {
                let tail = stderrText()
                lock.unlock()
                cont.resume(throwing: EngineError.exited(status: status, stderr: tail))
                return
            }
            nextID += 1
            let id = nextID
            waiting[id] = cont
            lock.unlock()
            do {
                var line = try request.encoded(id: id)
                line.append(UInt8(ascii: "\n"))
                writeLock.lock()
                defer { writeLock.unlock() }
                try input.fileHandleForWriting.write(contentsOf: line)
            } catch {
                take(id)?.resume(throwing: error)
            }
        }
        if case let .error(message) = reply { throw EngineError.failed(message) }
        return reply
    }

    /// Close the engine's input so it exits, and stop it if it has not exited after `grace` seconds.
    public func stop(grace: TimeInterval = 3) {
        writeLock.lock()
        try? input.fileHandleForWriting.close()
        writeLock.unlock()
        let process = self.process
        DispatchQueue.global().asyncAfter(deadline: .now() + grace) {
            if process.isRunning { process.terminate() }
        }
    }

    // MARK: - Internals

    private func take(_ id: Int) -> CheckedContinuation<Message, Error>? {
        lock.lock()
        defer { lock.unlock() }
        return waiting.removeValue(forKey: id)
    }

    private func receive(_ data: Data) {
        lock.lock()
        let lines = splitter.feed(data)
        lock.unlock()
        for line in lines {
            let envelope: Envelope
            do {
                envelope = try Envelope.decode(line)
            } catch {
                let detail = String(decoding: line.prefix(200), as: UTF8.self)
                if let id = Self.id(of: line), let cont = take(id) {
                    cont.resume(throwing: EngineError.unreadable(detail))
                } else {
                    onEvent(.error(EngineError.unreadable(detail).localizedDescription))
                }
                continue
            }
            if let id = envelope.id, let cont = take(id) {
                cont.resume(returning: envelope.message)
            } else {
                onEvent(envelope.message)
            }
        }
    }

    private static func id(of line: Data) -> Int? {
        guard let object = try? JSONSerialization.jsonObject(with: line), let dict = object as? [String: Any] else { return nil }
        return dict["id"] as? Int
    }

    private func keepStderr(_ data: Data) {
        lock.lock()
        stderrTail.append(data)
        if stderrTail.count > 4096 { stderrTail = stderrTail.suffix(4096) }
        lock.unlock()
    }

    /// Call with `lock` held.
    private func stderrText() -> String {
        String(decoding: stderrTail, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func terminated(_ status: Int32) {
        // Let the output handlers deliver what the engine wrote last.
        Thread.sleep(forTimeInterval: 0.05)
        lock.lock()
        exitStatus = status
        let error = EngineError.exited(status: status, stderr: stderrText())
        let pending = waiting
        waiting = [:]
        lock.unlock()
        for cont in pending.values { cont.resume(throwing: error) }
        onExit(error)
    }
}
