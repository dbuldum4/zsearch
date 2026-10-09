import Foundation

// Types for `zsearch serve` (src/serve.ts): one JSON object per line in each direction.
// Field names match the TypeScript side; keys the app does not use are ignored when decoding.

public struct LineMatch: Decodable, Hashable, Sendable {
    public var line: Int
    public var page: Int
    public var text: String
    public var ranges: [[Int]]
}

public struct SearchHit: Decodable, Hashable, Identifiable, Sendable {
    public var id: Int
    public var path: String
    public var display: String
    public var kind: String
    public var isDir: Bool
    public var size: Int
    /// Milliseconds since 1970.
    public var mtime: Double
    public var score: Double
    public var sources: [String]
    public var namePositions: [Int]
    public var lines: [LineMatch]
    public var matchCount: Int

    public var name: String { (path as NSString).lastPathComponent }
    public var folder: String { (display as NSString).deletingLastPathComponent }
    public var modified: Date { Date(timeIntervalSince1970: mtime / 1000) }
}

public struct SearchResponse: Decodable, Hashable, Sendable {
    public var query: String
    public var mode: String
    public var resolved: String
    public var strategy: String
    public var hits: [SearchHit]
    public var total: Int
    public var elapsedMs: Double
    public var partial: Bool
    public var notice: String?
    public var error: String?
}

public struct PreviewLine: Decodable, Hashable, Sendable {
    public var n: Int
    public var text: String
    public var ranges: [[Int]]
}

public struct FilePreview: Decodable, Hashable, Sendable {
    public var id: Int
    public var path: String
    public var display: String
    public var kind: String
    public var isDir: Bool
    public var size: Int
    public var mtime: Double
    public var lines: [PreviewLine]
    public var totalLines: Int
    public var focusLine: Int
    public var pageStarts: [Int]
    public var matchLines: [Int]
    public var message: String?
    public var note: String?
    public var source: String
}

public struct IndexStats: Decodable, Hashable, Sendable {
    public var files: Int
    public var folders: Int
    public var withContent: Int
    public var errors: Int
    public var skipped: Int
    public var pending: Int
    public var contentBytes: Int
    public var dbBytes: Int
    /// Milliseconds since 1970, or nil if no index run has finished.
    public var lastIndexedAt: Double?
    public var lastDurationMs: Double?
    public var roots: [String]
}

public struct IndexProgress: Decodable, Hashable, Sendable {
    public var phase: String
    public var scanned: Int
    public var added: Int
    public var updated: Int
    public var removed: Int
    public var contentTotal: Int
    public var contentDone: Int
    public var contentBytes: Int
    public var contentErrors: Int
    public var current: String
    public var elapsedMs: Double
    public var error: String?

    /// 0...1 while reading contents, nil while scanning.
    public var fraction: Double? {
        guard phase == "content", contentTotal > 0 else { return nil }
        return Double(contentDone) / Double(contentTotal)
    }
}

public struct ContentConfig: Codable, Hashable, Sendable {
    public var enabled: Bool

    public init(enabled: Bool) {
        self.enabled = enabled
    }
}

/// The settings the app reads and changes. Other settings are kept by the engine as they are.
public struct Config: Codable, Hashable, Sendable {
    public var roots: [String]
    public var includeHidden: Bool
    public var content: ContentConfig
    public var autoRefreshMinutes: Double
    public var defaultMode: String
    /// Extra gitignore-style patterns (or absolute folders) to skip.
    public var exclude: [String]
    public var respectGitignore: Bool
    public var followSymlinks: Bool
    /// Read contents inside cloud-synced folders (may download online-only files).
    public var cloudContent: Bool
}

public struct Ready: Decodable, Hashable, Sendable {
    public var version: String
    public var files: Int
    public var firstRun: Bool
    public var config: Config
}

public struct IndexDone: Decodable, Hashable, Sendable {
    /// "done", "cancelled", "error" or "locked".
    public var status: String
    public var progress: IndexProgress?
    public var error: String?
}

public enum Mode: String, Codable, CaseIterable, Sendable {
    case find, fuzzy
}

/// A request to the engine. `id` is added by `EngineConnection`.
public enum Request: Sendable {
    case search(query: String, mode: Mode, limit: Int = 200)
    case preview(file: Int, query: String, mode: Mode, focusLine: Int? = nil)
    case stats
    case config
    /// Only the fields that are set are changed.
    case setConfig(ConfigPatch)
    case index
    /// Empty the index and index everything again.
    case rebuildIndex
    case cancelIndex
    /// Previews of several files at once, for prefetching.
    case previews(files: [Int], query: String, mode: Mode)
    case opened(path: String)
}

public struct ConfigPatch: Encodable, Hashable, Sendable {
    public var roots: [String]?
    public var includeHidden: Bool?
    public var content: ContentConfig?
    public var defaultMode: String?
    public var exclude: [String]?
    public var respectGitignore: Bool?
    public var followSymlinks: Bool?
    public var cloudContent: Bool?
    public var autoRefreshMinutes: Double?

    public init(
        roots: [String]? = nil,
        includeHidden: Bool? = nil,
        content: ContentConfig? = nil,
        defaultMode: String? = nil,
        exclude: [String]? = nil,
        respectGitignore: Bool? = nil,
        followSymlinks: Bool? = nil,
        cloudContent: Bool? = nil,
        autoRefreshMinutes: Double? = nil
    ) {
        self.roots = roots
        self.includeHidden = includeHidden
        self.content = content
        self.defaultMode = defaultMode
        self.exclude = exclude
        self.respectGitignore = respectGitignore
        self.followSymlinks = followSymlinks
        self.cloudContent = cloudContent
        self.autoRefreshMinutes = autoRefreshMinutes
    }

    /// Every setting the app manages, taken from `config`.
    public init(_ config: Config) {
        self.init(
            roots: config.roots,
            includeHidden: config.includeHidden,
            content: config.content,
            defaultMode: config.defaultMode,
            exclude: config.exclude,
            respectGitignore: config.respectGitignore,
            followSymlinks: config.followSymlinks,
            cloudContent: config.cloudContent,
            autoRefreshMinutes: config.autoRefreshMinutes
        )
    }
}

extension Request {
    private struct Wire: Encodable {
        var id: Int
        var type: String
        var query: String?
        var mode: Mode?
        var limit: Int?
        var file: Int?
        var focusLine: Int?
        var config: ConfigPatch?
        var path: String?
        var files: [Int]?
        var rebuild: Bool?
    }

    /// The request as one line of JSON, without the trailing newline.
    public func encoded(id: Int) throws -> Data {
        var w = Wire(id: id, type: "")
        switch self {
        case let .search(query, mode, limit):
            w.type = "search"; w.query = query; w.mode = mode; w.limit = limit
        case let .preview(file, query, mode, focusLine):
            w.type = "preview"; w.file = file; w.query = query; w.mode = mode; w.focusLine = focusLine
        case .stats:
            w.type = "stats"
        case .config:
            w.type = "config"
        case let .setConfig(patch):
            w.type = "setConfig"; w.config = patch
        case .index:
            w.type = "index"
        case .rebuildIndex:
            w.type = "index"; w.rebuild = true
        case let .previews(files, query, mode):
            w.type = "previews"; w.files = files; w.query = query; w.mode = mode
        case .cancelIndex:
            w.type = "cancelIndex"
        case let .opened(path):
            w.type = "opened"; w.path = path
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(w)
    }
}

/// A reply or event from the engine.
public enum Message: Hashable, Sendable {
    case ready(Ready)
    case results(SearchResponse)
    case preview(FilePreview)
    case previews([FilePreview])
    case stats(IndexStats)
    case config(Config)
    case cancelled
    case ok
    case error(String)
    case indexProgress(IndexProgress)
    case indexDone(IndexDone)
    case refreshed(files: Int, changed: Bool)
    /// A message type this version of the app does not know.
    case unknown(type: String)
}

public struct Envelope: Hashable, Sendable {
    /// The request this replies to, or nil for events.
    public var id: Int?
    public var message: Message

    private struct Head: Decodable {
        var id: Int?
        var type: String
    }

    private struct ResultsBody: Decodable { var response: SearchResponse }
    private struct PreviewBody: Decodable { var preview: FilePreview }
    private struct PreviewsBody: Decodable { var previews: [FilePreview] }
    private struct StatsBody: Decodable { var stats: IndexStats }
    private struct ConfigBody: Decodable { var config: Config }
    private struct ProgressBody: Decodable { var progress: IndexProgress }
    private struct ErrorBody: Decodable { var error: String }
    private struct RefreshedBody: Decodable {
        var files: Int
        var changed: Bool
    }

    /// Decode one line of `zsearch serve` output.
    public static func decode(_ line: Data) throws -> Envelope {
        let d = JSONDecoder()
        let head = try d.decode(Head.self, from: line)
        let message: Message
        switch head.type {
        case "ready": message = .ready(try d.decode(Ready.self, from: line))
        case "results": message = .results(try d.decode(ResultsBody.self, from: line).response)
        case "preview": message = .preview(try d.decode(PreviewBody.self, from: line).preview)
        case "previews": message = .previews(try d.decode(PreviewsBody.self, from: line).previews)
        case "stats": message = .stats(try d.decode(StatsBody.self, from: line).stats)
        case "config": message = .config(try d.decode(ConfigBody.self, from: line).config)
        case "cancelled": message = .cancelled
        case "ok": message = .ok
        case "error": message = .error(try d.decode(ErrorBody.self, from: line).error)
        case "indexProgress": message = .indexProgress(try d.decode(ProgressBody.self, from: line).progress)
        case "indexDone": message = .indexDone(try d.decode(IndexDone.self, from: line))
        case "refreshed":
            let r = try d.decode(RefreshedBody.self, from: line)
            message = .refreshed(files: r.files, changed: r.changed)
        default: message = .unknown(type: head.type)
        }
        return Envelope(id: head.id, message: message)
    }
}
