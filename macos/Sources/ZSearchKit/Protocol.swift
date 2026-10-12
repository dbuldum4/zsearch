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
    public var contentAllowed: Bool?
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
    public var unreadableFolders: [String]?
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
    public var unreadableFolders: Int?
    public var phase: String
    public var scanned: Int
    public var added: Int
    public var updated: Int
    public var removed: Int
    public var contentTotal: Int
    public var contentDone: Int
    public var contentBytes: Int
    public var contentErrors: Int
    /// Why reading contents waits ("Low Power Mode", "on battery"), while it does.
    public var waiting: String?
    public var current: String
    public var elapsedMs: Double
    public var error: String?
    /// The semantic pass (search by meaning), after the contents are read.
    public var meaning: MeaningProgress?

    /// 0...1 while reading contents or for meaning, nil while scanning.
    public var fraction: Double? {
        if phase == "meaning", let m = meaning, m.total > 0 { return Double(m.done) / Double(m.total) }
        guard phase == "content", contentTotal > 0 else { return nil }
        return Double(contentDone) / Double(contentTotal)
    }
}

public struct MeaningProgress: Decodable, Hashable, Sendable {
    public var total: Int
    public var done: Int
    public var embedded: Int
    public var reused: Int
    public var error: String?
}

/// What a first index of a folder reads, from a count-only walk (`estimate` requests).
public struct FolderEstimate: Decodable, Hashable, Sendable {
    public var root: String
    public var files: Int
    public var folders: Int
    public var textFiles: Int
    public var textBytes: Int
    public var documents: Int
    public var ocrImages: Int
    /// False when the walk ran out of time: the counts and time are then a lower bound.
    public var complete: Bool
    /// The first pass, roughly.
    public var seconds: Double
}

public struct EstimateReply: Decodable, Hashable, Sendable {
    public var estimates: [FolderEstimate]
    public var total: FolderEstimate
    /// "12,345 files · about 3 minutes", as the engine words it.
    public var text: String
}

public struct ContentConfig: Codable, Hashable, Sendable {
    public var enabled: Bool
    /// Read the text in images and scanned PDF pages. Nil from engines older than OCR, and in
    /// patches that leave it as it is.
    public var ocr: Bool?
    public var metadata: Bool?

    public init(enabled: Bool, ocr: Bool? = nil, metadata: Bool? = nil) {
        self.enabled = enabled
        self.ocr = ocr
        self.metadata = metadata
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
    /// Update the index as files change while the app runs. Nil from engines that do not send it.
    public var liveUpdates: Bool?
    /// A big update the app started on its own waits in Low Power Mode or while the Mac is hot,
    /// and while on battery. Nil from engines older than these settings.
    public var pauseOnLowPower: Bool?
    public var pauseOnBattery: Bool?
    /// Search by meaning. Nil from engines without it.
    public var semantic: SemanticConfig?
}

public struct SemanticConfig: Codable, Hashable, Sendable {
    public var enabled: Bool
    /// Also embed what photos and screenshots show (needs the image encoder).
    public var images: Bool
    /// Also embed source code and data files.
    public var code: Bool

    public init(enabled: Bool, images: Bool, code: Bool) {
        self.enabled = enabled
        self.images = images
        self.code = code
    }
}

/// What search by meaning has: its setting, model, helper and index (`semanticStatus` replies).
public struct SemanticStatus: Decodable, Hashable, Sendable {
    public struct Model: Decodable, Hashable, Sendable {
        public var text: Bool
        public var media: Bool
        public var textBytes: Int
        public var mediaBytes: Int
    }

    public struct Index: Decodable, Hashable, Sendable {
        public var files: Int
        public var passages: Int
        public var vectors: Int
        public var partial: Int
        public var bytes: Int
        /// Milliseconds since 1970.
        public var lastRunAt: Double?
        public var error: String?
    }

    public var enabled: Bool
    public var images: Bool
    public var code: Bool
    public var helper: String?
    public var modelDir: String
    public var model: Model
    /// Why reading files for meaning doesn't run, or nil when it does.
    public var blocked: String?
    public var index: Index?
}

/// How far the model download is (`semanticDownload` events).
public struct DownloadProgress: Decodable, Hashable, Sendable {
    public var file: String
    public var received: Int
    public var total: Int
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
    case find, fuzzy, semantic
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
    /// An update the app started on its own (its schedule): a big one waits in Low Power Mode,
    /// while the Mac is hot or (optionally) on battery.
    case backgroundIndex
    /// Empty the index and index everything again.
    case rebuildIndex
    case cancelIndex
    /// Previews of several files at once, for prefetching. `focusLines[i]`, when given, is the
    /// line to show for `files[i]`, as `preview`'s `focusLine`.
    case previews(files: [Int], query: String, mode: Mode, focusLines: [Int?] = [])
    case opened(path: String)
    /// How long a first index of these folders takes. A newer one supersedes it (`cancelled`).
    case estimate(roots: [String])
    case semanticStatus
    /// Download the model (with the image encoder, if `images`) and turn search by meaning on.
    case semanticInstall(images: Bool)
    case semanticCancelInstall
    /// Turn search by meaning off and delete its model and index.
    case semanticRemove
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
    public var liveUpdates: Bool?
    public var pauseOnLowPower: Bool?
    public var pauseOnBattery: Bool?
    public var semantic: SemanticConfig?

    public init(
        roots: [String]? = nil,
        includeHidden: Bool? = nil,
        content: ContentConfig? = nil,
        defaultMode: String? = nil,
        exclude: [String]? = nil,
        respectGitignore: Bool? = nil,
        followSymlinks: Bool? = nil,
        cloudContent: Bool? = nil,
        autoRefreshMinutes: Double? = nil,
        liveUpdates: Bool? = nil,
        pauseOnLowPower: Bool? = nil,
        pauseOnBattery: Bool? = nil,
        semantic: SemanticConfig? = nil
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
        self.liveUpdates = liveUpdates
        self.pauseOnLowPower = pauseOnLowPower
        self.pauseOnBattery = pauseOnBattery
        self.semantic = semantic
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
            autoRefreshMinutes: config.autoRefreshMinutes,
            liveUpdates: config.liveUpdates,
            pauseOnLowPower: config.pauseOnLowPower,
            pauseOnBattery: config.pauseOnBattery,
            semantic: config.semantic
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
        var focusLines: [Int?]?
        var rebuild: Bool?
        var roots: [String]?
        var background: Bool?
        var images: Bool?
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
        case .backgroundIndex:
            w.type = "index"; w.background = true
        case .rebuildIndex:
            w.type = "index"; w.rebuild = true
        case let .previews(files, query, mode, focusLines):
            w.type = "previews"; w.files = files; w.query = query; w.mode = mode
            if !focusLines.isEmpty { w.focusLines = focusLines }
        case .cancelIndex:
            w.type = "cancelIndex"
        case let .opened(path):
            w.type = "opened"; w.path = path
        case let .estimate(roots):
            w.type = "estimate"; w.roots = roots
        case .semanticStatus:
            w.type = "semanticStatus"
        case let .semanticInstall(images):
            w.type = "semanticInstall"; w.images = images
        case .semanticCancelInstall:
            w.type = "semanticCancelInstall"
        case .semanticRemove:
            w.type = "semanticRemove"
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
    case estimate(EstimateReply)
    case semantic(SemanticStatus)
    case semanticDownload(DownloadProgress)
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
    private struct SemanticBody: Decodable { var status: SemanticStatus }
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
        case "estimate": message = .estimate(try d.decode(EstimateReply.self, from: line))
        case "semantic": message = .semantic(try d.decode(SemanticBody.self, from: line).status)
        case "semanticDownload": message = .semanticDownload(try d.decode(DownloadProgress.self, from: line))
        case "refreshed":
            let r = try d.decode(RefreshedBody.self, from: line)
            message = .refreshed(files: r.files, changed: r.changed)
        default: message = .unknown(type: head.type)
        }
        return Envelope(id: head.id, message: message)
    }
}
