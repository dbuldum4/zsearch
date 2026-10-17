import Foundation

/// The app's side of saved searches and search history, which the engine keeps
/// (src/searches.ts): names, what the menu shows, and when a search is worth remembering.
public enum SavedSearches {
    /// The longest name the engine takes.
    public static let nameLimit = 100

    /// A name as the engine stores it: runs of white space as one space, trimmed.
    public static func normalized(_ name: String) -> String {
        name.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// The name a new saved search starts with: the query's words without its filters, or the
    /// whole query when it is only filters, shortened.
    public static func suggestedName(for query: String) -> String {
        let words = normalized(QueryFilters.clearingFilters(query))
        let base = words.isEmpty ? normalized(query) : words
        guard base.count > 40 else { return base }
        return String(base.prefix(40)).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// The saved search called `name`: that exact name, or the same name in another case, as the
    /// engine matches names.
    public static func existing(named name: String, in saved: [SavedSearch]) -> SavedSearch? {
        let n = normalized(name)
        return saved.first { $0.name == n } ?? saved.first { $0.name.compare(n, options: .caseInsensitive) == .orderedSame }
    }

    /// Why `name` cannot be used, or nil when it can. Saving under a taken name replaces that
    /// search; renaming to one fails, except to the search's own name in another case.
    public static func problem(with name: String, in saved: [SavedSearch], renaming: SavedSearch? = nil) -> String? {
        let n = normalized(name)
        if n.isEmpty { return "Enter a name." }
        if n.count > nameLimit { return "Use at most \(nameLimit) characters." }
        if let renaming, let other = existing(named: n, in: saved), other != renaming {
            return "A saved search is already called “\(other.name)”."
        }
        return nil
    }

    /// The saved search that is this search, if there is one.
    public static func matching(query: String, mode: Mode, in saved: [SavedSearch]) -> SavedSearch? {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return saved.first { $0.query == q && $0.mode == mode }
    }

    /// Whether opening a result should add its search to the history: not for an empty query, nor
    /// when the search already is the newest entry (several results opened from it).
    public static func shouldRemember(query: String, mode: Mode, recent: [RecentSearch]) -> Bool {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return false }
        guard let newest = recent.first else { return true }
        return newest.query != q || newest.mode != mode
    }

    /// A search as a menu item: its query, shortened, and its mode unless that is Find or the app
    /// has only one mode.
    public static func menuTitle(query: String, mode: Mode, showsMode: Bool = true) -> String {
        let q = normalized(query)
        let shown = q.count > 60 ? String(q.prefix(60)).trimmingCharacters(in: .whitespaces) + "…" : q
        guard showsMode, mode != .find else { return shown }
        return "\(shown) · \(mode.rawValue.capitalized)"
    }
}
