import Foundation

/// Reads and edits the filter tokens of a query (`ext:pdf`, `in:~/Documents`, `/regex/`...), so
/// the filter row and the search field stay one source of truth: the query text. Tokens are
/// split the way the engine splits them (src/search/query.ts).
public enum QueryFilters {
    /// Filter keys the engine understands, and the groups of them that mean the same thing.
    public static let typeKeys = ["type", "kind"]
    public static let extKeys = ["ext"]
    public static let folderKeys = ["in", "dir"]
    public static let sizeKeys = ["size"]
    public static let modifiedKeys = ["modified", "mtime", "changed", "after", "since", "before"]
    static let allKeys: Set<String> = Set(typeKeys + extKeys + folderKeys + sizeKeys + modifiedKeys + ["path", "limit", "is"])

    static let regexPrefixes = ["re:", "regex:"]
    static let modePrefixes = ["re:", "regex:", "find:", "exact:", "grep:", "fuzzy:", "f:"]

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

    /// The value of the last filter with one of `keys` (`type:pdf` gives "pdf"), ignoring negated ones.
    public static func value(_ keys: [String], in query: String) -> String? {
        let (_, body) = splitPrefix(query)
        return tokens(body).last { t in t.matches(keys) }?.value
    }

    /// The key a filter in the query was written with (`modified`, `after`...), for labels.
    public static func key(_ keys: [String], in query: String) -> String? {
        let (_, body) = splitPrefix(query)
        return tokens(body).last { t in t.matches(keys) }?.key
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

    /// Whether any filter is set (negated ones included).
    public static func hasFilters(_ query: String) -> Bool {
        let (_, body) = splitPrefix(query)
        return tokens(body).contains { $0.key != nil }
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
        let (prefix, body) = splitPrefix(query)
        if regexPrefixes.contains(prefix.trimmingCharacters(in: .whitespaces).lowercased()) { return true }
        if !prefix.isEmpty { return false }
        let words = tokens(body).filter { $0.key == nil }
        guard let first = words.first, let last = words.last else { return false }
        let text = String(body[first.range.lowerBound..<last.range.upperBound])
        return text.count > 2 && text.range(of: #"^/.+/[imsux]*$"#, options: .regularExpression) != nil
    }

    /// The query with regex matching switched on (a `re:` prefix) or off (the prefix or `/…/` removed).
    public static func settingRegex(_ on: Bool, in query: String) -> String {
        guard on != isRegex(query) else { return query }
        let (prefix, body) = splitPrefix(query)
        if on { return "re:" + body.trimmingLeadingSpaces() }
        if !prefix.isEmpty { return body.trimmingLeadingSpaces() }
        // Unwrap `/pattern/flags`, leaving the filters around it alone.
        let words = tokens(body).filter { $0.key == nil }
        guard let first = words.first, let last = words.last else { return query }
        let range = first.range.lowerBound..<last.range.upperBound
        let pattern = String(body[range])
            .replacingOccurrences(of: #"^/"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"/[imsux]*$"#, with: "", options: .regularExpression)
        return body.replacingCharacters(in: range, with: pattern)
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
        guard !value.isEmpty, allKeys.contains(key.lowercased()) else {
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
