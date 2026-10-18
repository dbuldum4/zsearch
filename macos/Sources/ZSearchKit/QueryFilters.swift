import Foundation

/// Reads and edits the filter tokens of a query (`ext:pdf`, `in:~/Documents`, `/regex/`...), so
/// the filter row and the search field stay one source of truth: the query text. Tokens are
/// split the way the engine splits them (src/search/query.ts).
public enum QueryFilters {
    /// Filter keys the engine understands, and the groups of them that mean the same thing.
    public static let typeKeys = ["type", "kind", "is"]
    public static let extKeys = ["ext"]
    public static let folderKeys = ["in", "dir"]
    public static let sizeKeys = ["size"]
    public static let modifiedKeys = ["modified", "mtime", "changed", "after", "since", "before"]
    static let allKeys: Set<String> = Set(typeKeys + extKeys + folderKeys + sizeKeys + modifiedKeys
        + ["path", "limit", "created", "tag", "name", "sort", "case", "word", "diacritics", "near", "fold"])

    /// Type names the engine accepts (KIND_ALIASES in src/kinds.ts). `is:` is only a filter when
    /// one of its values is among them; otherwise the engine keeps it as text (`is:open`).
    static let kindAliases: Set<String> = [
        "dir", "dirs", "folder", "folders", "directory", "code", "source", "src", "text", "txt", "md", "markdown",
        "note", "notes", "data", "config", "web", "html", "pdf", "doc", "docs", "document", "documents", "word",
        "sheet", "sheets", "spreadsheet", "excel", "xls", "slides", "slide", "presentation", "powerpoint", "ppt",
        "ebook", "book", "email", "mail", "image", "images", "img", "photo", "photos", "picture", "audio", "music",
        "sound", "video", "videos", "movie", "archive", "zip", "app", "binary", "other",
    ]

    static let regexPrefixes = ["re:", "regex:"]
    static let modePrefixes = ["re:", "regex:", "find:", "exact:", "grep:", "fuzzy:", "f:", "semantic:", "meaning:", "s:"]
    /// JavaScript's flags, as accepted by src/search/query.ts, including multiline patterns.
    static let delimitedRegex = #"^/[\s\S]+/[dgimsuvy]*$"#
    /// The engine also detects a leading /…/ before removing filters, even with trailing text.
    static let leadingDelimitedRegex = #"^/[\s\S]*/[dgimsuvy]*(?:\s|$)"#

    struct Token {
        var range: Range<String.Index>
        /// Filter key (lower-cased) and value, when the token is a filter.
        var key: String?
        var value: String
        var negated: Bool

        func matches(_ keys: [String]) -> Bool {
            guard let key, !negated else { return false }
            return keys.contains(key)
        }
    }

    /// A query split into its mode prefix and tokens once, for callers that ask several questions
    /// about the same query (the filter row asks about a dozen on every keystroke).
    public struct Parsed {
        let prefix: String
        let body: String
        let tokens: [Token]

        public init(_ query: String) {
            let split = QueryFilters.splitPrefix(query)
            prefix = split.prefix
            body = split.body
            tokens = QueryFilters.tokens(split.body)
        }

        /// See `QueryFilters.value(_:in:)`.
        public func value(_ keys: [String]) -> String? {
            tokens.last { t in t.matches(keys) }?.value
        }

        /// See `QueryFilters.key(_:in:)`.
        public func key(_ keys: [String]) -> String? {
            tokens.last { t in t.matches(keys) }?.key
        }

        /// See `QueryFilters.hasFilters(_:)`.
        public var hasFilters: Bool {
            tokens.contains { $0.key != nil }
        }

        /// See `QueryFilters.isRegex(_:)`.
        public var isRegex: Bool {
            if QueryFilters.regexPrefixes.contains(prefix.trimmingCharacters(in: .whitespaces).lowercased()) { return true }
            if !prefix.isEmpty { return false }
            let lead = String(body.drop(while: { $0.isWhitespace }))
            if lead.range(of: QueryFilters.leadingDelimitedRegex, options: .regularExpression) != nil { return true }
            let words = tokens.filter { $0.key == nil }
            guard let first = words.first, let last = words.last else { return false }
            let text = String(body[first.range.lowerBound..<last.range.upperBound])
            return text.range(of: QueryFilters.delimitedRegex, options: .regularExpression) != nil
        }
    }

    /// The value of the last filter with one of `keys` (`type:pdf` gives "pdf"), ignoring negated ones.
    public static func value(_ keys: [String], in query: String) -> String? {
        Parsed(query).value(keys)
    }

    /// Whether a `type:` value names no type the engine knows (`docx`, `imgae`), so the engine
    /// drops the filter and searches every type. `pdf,docx` still filters, by its PDF part.
    public static func isUnknownType(_ value: String) -> Bool {
        !value.lowercased().split(separator: ",").contains { kindAliases.contains(String($0)) }
    }

    /// The key a filter in the query was written with (`modified`, `after`...), for labels.
    public static func key(_ keys: [String], in query: String) -> String? {
        Parsed(query).key(keys)
    }

    /// The query with every filter in `keys` removed and, when `value` is set, `keys[0]:value` added at the end.
    public static func setting(_ keys: [String], to value: String?, in query: String) -> String {
        let (prefix, body) = splitPrefix(query)
        var out = body
        for t in tokens(body).reversed() where t.matches(keys) {
            out = remove(t.range, from: out)
        }
        if let value, !value.isEmpty, let key = keys.first {
            let token = "\(key):" + (value.contains(" ") ? "\"\(value)\"" : value)
            let trimmed = out.trimmingTrailingSpaces()
            out = trimmed.isEmpty ? token : trimmed + " " + token
        }
        return prefix + out
    }

    /// A sort header alternates ascending and descending without changing quoted search text or paths.
    public static func togglingSort(_ key: String, in query: String) -> String {
        let descending = value(["sort"], in: query) == key
        return setting(["sort"], to: (descending ? "-" : "") + key, in: query)
    }

    public static func togglingFold(in query: String) -> String {
        let on = ["on", "true"].contains(value(["fold"], in: query)?.lowercased() ?? "")
        return setting(["fold"], to: on ? "off" : "on", in: query)
    }

    /// Whether two queries find the same results: they differ at most in `sort:`, which orders
    /// the results, and `fold:`, which only shapes their previews.
    public static func sameResults(_ a: String, _ b: String) -> Bool {
        func rest(_ query: String) -> String {
            let (prefix, body) = splitPrefix(query)
            var out = body
            for t in tokens(body).reversed() where t.key == "sort" || t.key == "fold" { out = remove(t.range, from: out) }
            return (prefix + out).trimmingCharacters(in: .whitespaces)
        }
        return rest(a) == rest(b)
    }

    /// Whether any filter is set (negated ones included).
    public static func hasFilters(_ query: String) -> Bool {
        Parsed(query).hasFilters
    }

    /// The query with all filters removed.
    public static func clearingFilters(_ query: String) -> String {
        let (prefix, body) = splitPrefix(query)
        var out = body
        for t in tokens(body).reversed() where t.key != nil { out = remove(t.range, from: out) }
        return prefix + out.trimmingTrailingSpaces()
    }

    /// Whether the query is a regular expression: `re:…`, `regex:…` or `/…/`.
    public static func isRegex(_ query: String) -> Bool {
        Parsed(query).isRegex
    }

    /// The query with regex matching switched on (a `re:` prefix) or off (the prefix or `/…/` removed).
    public static func settingRegex(_ on: Bool, in query: String) -> String {
        guard on != isRegex(query) else { return query }
        let (_, body) = splitPrefix(query)
        if on { return "re:" + body.trimmingLeadingSpaces() }
        // Remove the prefix and unwrap `/pattern/flags`, leaving the filters around it alone.
        // `re:/pattern/g` needs both removed, or it would still run as a regex.
        let plain = body.trimmingLeadingSpaces()
        let words = tokens(plain).filter { $0.key == nil }
        guard let first = words.first, let last = words.last else { return literalQuery(plain) }
        let range = first.range.lowerBound..<last.range.upperBound
        let delimited = String(plain[range])
        guard delimited.range(of: Self.delimitedRegex, options: .regularExpression) != nil else { return literalQuery(plain) }
        let pattern = delimited
            .replacingOccurrences(of: #"^/"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"/[dgimsuvy]*$"#, with: "", options: .regularExpression)
        return literalQuery(plain.replacingCharacters(in: range, with: pattern))
    }

    /// Removing regex syntax can expose more syntax (`//budget//` becomes `/budget/`, or
    /// `re:re:budget` becomes `re:budget`). Force literal mode only when needed to keep it off.
    private static func literalQuery(_ query: String) -> String {
        let lead = query.drop(while: { $0.isWhitespace }).lowercased()
        if isRegex(query) || lead.hasPrefix("all:") || modePrefixes.contains(where: { lead.hasPrefix($0) }) {
            return "find:" + query
        }
        return query
    }

    // MARK: - Tokens

    /// Split off a leading mode prefix (`re:`, `fuzzy:`...), as the engine does before reading filters.
    static func splitPrefix(_ query: String) -> (prefix: String, body: String) {
        let lead = query.trimmingLeadingSpaces()
        for p in modePrefixes where lead.lowercased().hasPrefix(p) {
            let end = query.index(query.endIndex, offsetBy: -(lead.count - p.count))
            return (String(query[..<end]), String(query[end...]))
        }
        return ("", query)
    }

    /// `"quoted phrases"`, filters with a quoted value (`in:"~/My Folder"`), and other words.
    static func tokens(_ s: String) -> [Token] {
        var out: [Token] = []
        var i = s.startIndex
        while i < s.endIndex {
            if s[i].isWhitespace {
                i = s.index(after: i)
                continue
            }
            let start = i
            if s[i] == "\"" {
                i = s.index(after: i)
                while i < s.endIndex, s[i] != "\"" { i = s.index(after: i) }
                if i < s.endIndex { i = s.index(after: i) }
                out.append(Token(range: start..<i, key: nil, value: "", negated: false))
                continue
            }
            while i < s.endIndex, !s[i].isWhitespace {
                // A filter's quoted value runs to the closing quote, spaces included.
                if s[i] == "\"", s[s.index(before: i)] == ":", isFilterKey(s[start..<s.index(before: i)]) {
                    i = s.index(after: i)
                    while i < s.endIndex, s[i] != "\"" { i = s.index(after: i) }
                    if i < s.endIndex { i = s.index(after: i) }
                    break
                }
                i = s.index(after: i)
            }
            out.append(filterToken(s, start..<i))
        }
        return out
    }

    private static func isFilterKey(_ s: Substring) -> Bool {
        allKeys.contains((s.hasPrefix("-") ? s.dropFirst() : s).lowercased())
    }

    private static func filterToken(_ s: String, _ range: Range<String.Index>) -> Token {
        let text = s[range]
        guard let colon = text.firstIndex(of: ":") else { return Token(range: range, key: nil, value: "", negated: false) }
        var key = text[..<colon]
        let negated = key.hasPrefix("-")
        if negated { key = key.dropFirst() }
        var value = String(text[text.index(after: colon)...])
        if value.hasPrefix("\"") {
            value.removeFirst()
            if value.hasSuffix("\"") { value.removeLast() }
        }
        let isKnownIs = key.lowercased() != "is"
            || value.lowercased().split(separator: ",").contains { kindAliases.contains(String($0)) }
        guard !value.isEmpty, allKeys.contains(key.lowercased()), isKnownIs else {
            return Token(range: range, key: nil, value: "", negated: false)
        }
        return Token(range: range, key: key.lowercased(), value: value, negated: negated)
    }

    /// Remove a token and the spaces after it, or before it when it ends the text.
    private static func remove(_ range: Range<String.Index>, from s: String) -> String {
        var lower = range.lowerBound
        var upper = range.upperBound
        while upper < s.endIndex, s[upper] == " " { upper = s.index(after: upper) }
        if upper == s.endIndex {
            while lower > s.startIndex, s[s.index(before: lower)] == " " { lower = s.index(before: lower) }
        }
        var out = s
        out.removeSubrange(lower..<upper)
        return out
    }
}

extension String {
    func trimmingLeadingSpaces() -> String { String(drop(while: { $0 == " " })) }
    func trimmingTrailingSpaces() -> String {
        var s = self
        while s.hasSuffix(" ") { s.removeLast() }
        return s
    }
}
