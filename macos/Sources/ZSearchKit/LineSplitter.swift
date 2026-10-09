import Foundation

/// Splits a byte stream into newline-terminated lines. Bytes after the last newline are kept for the next chunk.
public struct LineSplitter {
    private var buffer = Data()

    public init() {}

    public mutating func feed(_ chunk: Data) -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        while let nl = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let line = buffer[buffer.startIndex..<nl]
            if !line.isEmpty { lines.append(Data(line)) }
            buffer.removeSubrange(buffer.startIndex...nl)
        }
        return lines
    }
}
