import Foundation

/// The engine's reply to `Request.explain`: why `query` (as sent) finds nothing in `mode`.
/// `diagnosis` is nil when it finds something, or there is nothing to say.
public struct DiagnosisReply: Decodable, Hashable, Sendable {
    public var query: String
    public var mode: String
    public var diagnosis: SearchDiagnosis?
}

/// Why a search found nothing, and what would find something (src/search/diagnose.ts). Parts
/// that don't apply are nil.
public struct SearchDiagnosis: Decodable, Hashable, Sendable {
    public struct FilterProbe: Decodable, Hashable, Sendable {
        /// "date", "created", "size", "type", "folder", "path", "name", "tag", or "all".
        public var filter: String
        /// The query without the filter, as the engine was sent it.
        public var query: String
        public var count: Int
        /// There are more results than `count`.
        public var more: Bool
    }

    public struct Folder: Decodable, Hashable, Sendable {
        /// `~/…` when inside the home folder.
        public var path: String
        /// "outside", "excluded", "namesOnly" or "missing".
        public var reason: String
    }

    public struct ModeProbe: Decodable, Hashable, Sendable {
        public var mode: String
        public var count: Int
        public var more: Bool
    }

    public var filters: [FilterProbe]?
    public var folders: [Folder]?
    public var contentsOff: Bool?
    /// Files the query's filters allow whose contents could not be read.
    public var unreadable: Int?
    /// There may be more unreadable files than `unreadable`: the engine stopped counting.
    public var unreadableMore: Bool?
    public var indexing: Bool?
    public var semanticPending: Bool?
    public var modes: [ModeProbe]?
    /// The query with similar indexed words in place of unknown ones.
    public var suggestion: String?
}

/// What the empty result list says, and the action each line offers.
public struct NoResultsHelp: Hashable, Sendable {
    public enum Action: Hashable, Sendable {
        /// Search for this query instead.
        case query(String)
        case mode(Mode)
        case settings
    }

    public struct Item: Hashable, Sendable, Identifiable {
        public var text: String
        /// The title of the button for `action`.
        public var button: String?
        public var action: Action?
        public var id: String { text }
    }

    public var items: [Item] = []

    /// `indexing`: the app is running an update.
    public init(_ diagnosis: SearchDiagnosis?, indexing: Bool = false) {
        let d = diagnosis
        for f in d?.folders ?? [] {
            switch f.reason {
            case "outside": items.append(Item(text: "\(f.path) is not in the indexed folders.", button: "Settings…", action: .settings))
            case "excluded": items.append(Item(text: "\(f.path) is excluded from the index.", button: "Settings…", action: .settings))
            case "namesOnly": items.append(Item(text: "Only file names are indexed in \(f.path).", button: "Settings…", action: .settings))
            case "missing": items.append(Item(text: "\(f.path) does not exist."))
            default: break
            }
        }
        for f in d?.filters ?? [] {
            let label = Self.filterLabels[f.filter] ?? f.filter.capitalized
            let all = f.filter == "all"
            items.append(Item(
                text: "\(Self.results(f.count, more: f.more)) without \(all ? "filters" : "the \(label.lowercased()) filter").",
                button: all ? "Remove All Filters" : "Remove \(label) Filter",
                action: .query(f.query)
            ))
        }
        if let query = d?.suggestion {
            items.append(Item(text: "Did you mean “\(query)”?", button: "Search for It", action: .query(query)))
        }
        for m in d?.modes ?? [] {
            guard let mode = Mode(rawValue: m.mode) else { continue }
            let name = mode == .find ? "Find" : mode == .fuzzy ? "Fuzzy search" : "Semantic search"
            let button = mode == .find ? "Try Find" : mode == .fuzzy ? "Try Fuzzy Search" : "Try Semantic Search"
            items.append(Item(text: "\(name) finds \(Self.results(m.count, more: m.more)).", button: button, action: .mode(mode)))
        }
        if d?.contentsOff == true {
            items.append(Item(text: "File contents are off: only names were searched.", button: "Settings…", action: .settings))
        }
        if let n = d?.unreadable, n > 0 {
            let more = d?.unreadableMore == true
            items.append(Item(text: n == 1 && !more ? "1 indexed file could not be read, so its text was not searched." : "\(more ? "At least " : "")\(n) indexed files could not be read, so their text was not searched."))
        }
        if indexing || d?.indexing == true {
            items.append(Item(text: "Indexing is still running: results may be incomplete."))
        }
        if d?.semanticPending == true {
            items.append(Item(text: "Semantic indexing hasn't finished: only words were matched."))
        }
    }

    /// How long a query without results stays the same before the app asks why, in seconds:
    /// explaining runs more searches, which typing should not wait behind.
    public static let explainDelay = 0.35

    /// Whether to ask why `response`, the results shown for `sentQuery` (as sent) in `mode`, found nothing.
    public static func shouldExplain(_ response: SearchResponse?, sentQuery: String, mode: Mode) -> Bool {
        guard let r = response, r.hits.isEmpty, r.error == nil, r.query == sentQuery, r.mode == mode.rawValue else { return false }
        return !sentQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The diagnosis to show for `sentQuery` in `mode`: nil when `reply` is for another query or mode.
    public static func current(_ reply: DiagnosisReply?, sentQuery: String, mode: Mode) -> SearchDiagnosis? {
        guard let reply, reply.query == sentQuery, reply.mode == mode.rawValue else { return nil }
        return reply.diagnosis
    }

    static let filterLabels = [
        "date": "Date", "created": "Created", "size": "Size", "type": "Type",
        "folder": "Folder", "path": "Path", "name": "Name", "tag": "Tag",
    ]

    static func results(_ n: Int, more: Bool) -> String {
        n == 1 && !more ? "1 result" : "\(n)\(more ? "+" : "") results"
    }
}
