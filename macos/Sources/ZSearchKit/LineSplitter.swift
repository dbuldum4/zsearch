import Foundation

/// Splits a byte stream into newline-terminated lines. Bytes after the last newline are kept for the next chunk.
public struct LineSplitter {
    private var buffer = Data()
    /// Bytes of `buffer` already searched for a newline: each chunk is scanned once, however
    /// many chunks a long line spans.
    private var scanned = 0

    public init() {}

    public mutating func feed(_ chunk: Data) -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        var start = buffer.startIndex
        var from = buffer.startIndex + scanned
        while let nl = buffer[from...].firstIndex(of: UInt8(ascii: "\n")) {
            if nl > start { lines.append(Data(buffer[start..<nl])) }
            start = nl + 1
            from = start
        }
        // One removal per chunk rather than one per line.
        if start > buffer.startIndex { buffer = Data(buffer[start...]) }
        scanned = buffer.count
        return lines
    }
}
