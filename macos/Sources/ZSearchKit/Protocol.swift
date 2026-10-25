import Foundation

// Types for `zsearch serve` (src/serve.ts): one JSON object per line in each direction.
// Field names match the TypeScript side; keys the app does not use are ignored when decoding.

public struct LineMatch: Decodable, Hashable, Sendable {
    public var line: Int
    public var page: Int
    public var text: String
    public var ranges: [[Int]]
    /// Audio and video: where the line's transcript segment starts, in seconds.
    public var startSeconds: Double?
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
    /// Byte-identical files folded into this one, when the search asked for `groupDuplicates`.
    public var copies: [FileCopy]?
    /// More indexed files share this hit's size than the copies listed: there may be more of them.
    public var copiesMore: Bool?

    public var name: String { (path as NSString).lastPathComponent }
    public var folder: String { (display as NSString).deletingLastPathComponent }
    public var modified: Date { Date(timeIntervalSince1970: mtime / 1000) }
    /// This file and its identical copies.
    public var copyCount: Int { 1 + (copies?.count ?? 0) }
}

public struct FileCopy: Decodable, Hashable, Identifiable, Sendable {
    public var id: Int
    public var path: String
    public var display: String
    /// Milliseconds since 1970.
    public var mtime: Double

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
    /// Present on related-file responses.
    public var source: FileCopy?
    public var status: String?
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
    /// Milliseconds since 1970, or nil if no index run has finished: when a run last updated
    /// the index, a full walk or a refresh of the files that changed.
    public var lastIndexedAt: Double?
    public var lastDurationMs: Double?
    /// When a run last walked every folder, which the timed update goes by (older engines: nil).
    public var lastFullWalkAt: Double?
    public var roots: [String]
    /// How far semantic search has caught up, or nil when it is off or cannot run.
    public var semantic: SemanticCoverage?
}

/// The files semantic search should know: how many have vectors made from their text as it is
/// (`current`), and how many still wait for them (`pending`).
public struct SemanticCoverage: Decodable, Hashable, Sendable {
    public var files: Int
    public var current: Int
    public var pending: Int
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
    /// The run updates the files that changed only, not every folder (older engines: nil).
    public var partial: Bool?
    /// The semantic pass (semantic search), after the contents are read.
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
    public var mediaFiles: Int?
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
    public var transcribe: Bool?
    public var transcriptionLocale: String?

    public init(enabled: Bool, ocr: Bool? = nil, metadata: Bool? = nil, transcribe: Bool? = nil, transcriptionLocale: String? = nil) {
        self.enabled = enabled
        self.ocr = ocr
        self.metadata = metadata
        self.transcribe = transcribe
        self.transcriptionLocale = transcriptionLocale
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
    /// Semantic search. Nil from engines without it.
    public var semantic: SemanticConfig?
    /// Keep and show the searches results were opened from. Nil from engines older than this setting.
    public var searchHistory: Bool?
}

public struct SemanticConfig: Codable, Hashable, Sendable {
    public var enabled: Bool
    /// Someone turned semantic search off: the app doesn't download its model when it starts.
    /// Nil from older engines.
    public var declined: Bool?
    /// Also embed source code and data files.
    public var code: Bool

    public init(enabled: Bool, declined: Bool? = nil, code: Bool) {
        self.enabled = enabled
        self.declined = declined
        self.code = code
    }
}

/// What semantic search has: its setting, model, helper and index (`semanticStatus` replies).
public struct SemanticStatus: Decodable, Hashable, Sendable {
    /// The local Granite model.
    public struct Model: Decodable, Hashable, Sendable {
        public var ready: Bool
        public var bytes: Int
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
    public var declined: Bool
    public var code: Bool
    public var helper: String?
    public var modelDir: String
    public var model: Model
    /// Why reading files for meaning doesn't run, or nil when it does.
    public var blocked: String?
    /// Granite's index.
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

/// A file whose contents search cannot find, or finds only in part (`problems` replies).
public struct IndexProblem: Decodable, Hashable, Identifiable, Sendable {
    public var path: String
    public var size: Int
    /// Milliseconds since 1970.
    public var mtime: Double
    /// "unreadable", "timeout", "transcription", "too-large", "no-text", "truncated", "dataset",
    /// "secret", "names-only" or "cloud".
    public var category: String
    /// Why, in plain words, and what would change it.
    public var reason: String
    /// The reader's own error, for files that could not be read.
    public var detail: String?
    /// When its contents were last read (milliseconds since 1970), if known.
    public var at: Double?
    /// Reading the file again may help (`retryProblems`).
    public var retry: Bool
    /// The engine setting that decides it, if one does (`zsearch config` key).
    public var setting: String?

    public var id: String { path }
    public var name: String { (path as NSString).lastPathComponent }
    public var modified: Date { Date(timeIntervalSince1970: mtime / 1000) }
}

/// How many files have a kind of problem.
public struct ProblemCount: Decodable, Hashable, Identifiable, Sendable {
    public var category: String
    /// The category in plain words ("Could not be read").
    public var label: String
    public var count: Int
    public var retry: Bool

    public var id: String { category }
}

/// A page of indexing problems (`problems` replies).
public struct ProblemList: Decodable, Hashable, Sendable {
    public var problems: [IndexProblem]
    /// Problems the filter matches, in all pages.
    public var total: Int
    /// Problems by category, with the search text applied but not the category filter.
    public var categories: [ProblemCount]
}

/// Why one file's contents are, or are not, searchable (`explain` replies).
public struct Explanation: Decodable, Hashable, Sendable {
    public var path: String
    /// "content" (its text is searchable), "name" (only its name) or "none" (not in the index).
    public var searchable: String
    public var category: String?
    public var reason: String
    public var detail: String?
    public var retry: Bool
    public var setting: String?
    public var at: Double?
}

/// What a `retryProblems` request marked to be read again.
public struct RetryResult: Decodable, Hashable, Sendable {
    public struct Refusal: Decodable, Hashable, Sendable {
        public var path: String
        public var reason: String
    }

    public var retried: Int
    /// Files a retry would not help, and why.
    public var refused: [Refusal]
    /// When the marked files will be read: an update starts "now", one is running ("next": the
    /// one that follows it reads them), or another zsearch process holds the index ("waiting").
    /// Absent from engines that predate the field, and when nothing was marked.
    public var reading: String?
}

public enum Mode: String, Codable, CaseIterable, Sendable {
    case find, fuzzy, semantic
}

/// A search kept under a name. Filters and sorting are part of the query text.
public struct SavedSearch: Codable, Hashable, Sendable, Identifiable {
    public var name: String
    public var query: String
    public var mode: Mode

    public var id: String { name }

    public init(name: String, query: String, mode: Mode) {
        self.name = name
        self.query = query
        self.mode = mode
    }
}

/// A search a result was opened from (`rememberSearch`).
public struct RecentSearch: Codable, Hashable, Sendable, Identifiable {
    public var query: String
    public var mode: Mode
    /// Milliseconds since 1970.
    public var at: Double

    public var id: String { query }

    public init(query: String, mode: Mode, at: Double) {
        self.query = query
        self.mode = mode
        self.at = at
    }
}

/// Saved searches by name, and recent searches newest first (`searches` replies).
public struct Searches: Decodable, Hashable, Sendable {
    public var saved: [SavedSearch]
    public var recent: [RecentSearch]

    public init(saved: [SavedSearch] = [], recent: [RecentSearch] = []) {
        self.saved = saved
        self.recent = recent
    }
}

/// A request to the engine. `id` is added by `EngineConnection`.
public enum Request: Sendable {
    /// `groupDuplicates`: one hit per set of byte-identical files, listing the others as `copies`.
    case search(query: String, mode: Mode, limit: Int = 200, groupDuplicates: Bool = false)
    /// Discover from stored passage vectors; the token identifies a cancellable navigation generation.
    case related(file: String, limit: Int = 20, token: Int)
    case cancelRelated(token: Int)
    /// Why a search finds nothing, once its query has stayed the same for a moment.
    case explain(query: String, mode: Mode, limit: Int = 200)
    case preview(file: Int, query: String, mode: Mode, focusLine: Int? = nil)
    case stats
    case config
    /// Only the fields that are set are changed.
    case setConfig(ConfigPatch)
    case index
    /// Build only the Granite semantic index, from text earlier runs already read:
    /// no scanning and no word-index pass.
    case meaningIndex
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
    /// Download Granite and turn semantic search on.
    case semanticInstall
    case semanticCancelInstall
    /// Turn semantic search off and delete its model and index.
    case semanticRemove
    /// A page of the files whose contents search cannot find, by category and then path. No
    /// categories means all; `query` keeps paths containing it.
    case problems(categories: [String] = [], query: String = "", offset: Int = 0, limit: Int = 200)
    /// Why one file's contents are, or are not, searchable.
    case explainPath(path: String)
    /// Read these files again; the engine then starts an index update.
    case retryProblems(paths: [String])
    /// Read every file of a category again ("unreadable", "timeout", "transcription", "no-text").
    case retryCategory(String)
    /// Saved searches and recent history. This and the changes below reply `searches`.
    case searches
    /// Save under `name`, replacing the saved search already called that (in any case).
    case saveSearch(name: String, query: String, mode: Mode)
    case renameSearch(name: String, to: String)
    case deleteSearch(name: String)
    /// Keep a search a result was opened from in the history.
    case rememberSearch(query: String, mode: Mode)
    case clearRecent
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
    public var searchHistory: Bool?
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
        searchHistory: Bool? = nil,
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
        self.searchHistory = searchHistory
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
            searchHistory: config.searchHistory,
            semantic: config.semantic
        )
    }
}

extension Request {
    private enum FileReference: Encodable {
        case id(Int), path(String)
        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case let .id(value): try container.encode(value)
            case let .path(value): try container.encode(value)
            }
        }
    }

    private struct Wire: Encodable {
        var id: Int
        var type: String
        var query: String?
        var mode: Mode?
        var limit: Int?
        var file: FileReference?
        var focusLine: Int?
        var token: Int?
        var config: ConfigPatch?
        var path: String?
        var files: [Int]?
        var focusLines: [Int?]?
        var rebuild: Bool?
        var roots: [String]?
        var background: Bool?
        var groupDuplicates: Bool?
        var categories: [String]?
        var offset: Int?
        var paths: [String]?
        var category: String?
        var name: String?
        var to: String?
    }

    /// The request as one line of JSON, without the trailing newline.
    public func encoded(id: Int) throws -> Data {
        var w = Wire(id: id, type: "")
        switch self {
        case let .search(query, mode, limit, groupDuplicates):
            w.type = "search"; w.query = query; w.mode = mode; w.limit = limit
            if groupDuplicates { w.groupDuplicates = true }
        case let .related(file, limit, token):
            w.type = "related"; w.file = .path(file); w.limit = limit; w.token = token
        case let .cancelRelated(token):
            w.type = "cancelRelated"; w.token = token
        case let .explain(query, mode, limit):
            w.type = "explain"; w.query = query; w.mode = mode; w.limit = limit
        case let .preview(file, query, mode, focusLine):
            w.type = "preview"; w.file = .id(file); w.query = query; w.mode = mode; w.focusLine = focusLine
        case .stats:
            w.type = "stats"
        case .config:
            w.type = "config"
        case let .setConfig(patch):
            w.type = "setConfig"; w.config = patch
        case .index:
            w.type = "index"
        case .meaningIndex:
            w.type = "meaningIndex"
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
        case .semanticInstall:
            w.type = "semanticInstall"
        case .semanticCancelInstall:
            w.type = "semanticCancelInstall"
        case .semanticRemove:
            w.type = "semanticRemove"
        case let .problems(categories, query, offset, limit):
            w.type = "problems"; w.offset = offset; w.limit = limit
            if !categories.isEmpty { w.categories = categories }
            if !query.isEmpty { w.query = query }
        case let .explainPath(path):
            w.type = "explain"; w.path = path
        case let .retryProblems(paths):
            w.type = "retryProblems"; w.paths = paths
        case let .retryCategory(category):
            w.type = "retryProblems"; w.category = category
        case .searches:
            w.type = "searches"
        case let .saveSearch(name, query, mode):
            w.type = "saveSearch"; w.name = name; w.query = query; w.mode = mode
        case let .renameSearch(name, to):
            w.type = "renameSearch"; w.name = name; w.to = to
        case let .deleteSearch(name):
            w.type = "deleteSearch"; w.name = name
        case let .rememberSearch(query, mode):
            w.type = "rememberSearch"; w.query = query; w.mode = mode
        case .clearRecent:
            w.type = "clearRecent"
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
    case related(SearchResponse)
    case diagnosis(DiagnosisReply)
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
    case problems(ProblemList)
    case explanation(Explanation)
    case retried(RetryResult)
    case searches(Searches)
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
    private struct ExplanationBody: Decodable { var explanation: Explanation }
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
        case "related": message = .related(try d.decode(ResultsBody.self, from: line).response)
        case "results": message = .results(try d.decode(ResultsBody.self, from: line).response)
        case "diagnosis": message = .diagnosis(try d.decode(DiagnosisReply.self, from: line))
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
        case "problems": message = .problems(try d.decode(ProblemList.self, from: line))
        case "explanation": message = .explanation(try d.decode(ExplanationBody.self, from: line).explanation)
        case "retried": message = .retried(try d.decode(RetryResult.self, from: line))
        case "searches": message = .searches(try d.decode(Searches.self, from: line))
        case "refreshed":
            let r = try d.decode(RefreshedBody.self, from: line)
            message = .refreshed(files: r.files, changed: r.changed)
        default: message = .unknown(type: head.type)
        }
        return Envelope(id: head.id, message: message)
    }
}
