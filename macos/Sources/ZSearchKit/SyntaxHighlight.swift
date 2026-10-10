import Foundation

/// What a highlighted piece of code is.
public enum SyntaxKind: Hashable, Sendable {
    case keyword
    case type
    case string
    case number
    case comment
    /// Attributes and decorators (`@main`), preprocessor lines (`#include`), markup tag names.
    case meta
}

/// One highlighted piece of a line: [start, end) in UTF-16 code units, the unit NSString uses.
public struct SyntaxToken: Hashable, Sendable {
    public var kind: SyntaxKind
    public var start: Int
    public var end: Int

    public init(_ kind: SyntaxKind, _ start: Int, _ end: Int) {
        self.kind = kind
        self.start = start
        self.end = end
    }
}

/// The rules for one language. Deliberately small: enough to color keywords, strings, comments
/// and numbers line by line, not a parser.
public struct SyntaxLanguage: Sendable {
    public var name: String
    var keywords: Set<String> = []
    var types: Set<String> = []
    var lineComments: [String] = []
    var blockComment: (open: String, close: String)?
    /// Quote characters that start a string on one line.
    var quotes: Set<Character> = ["\"", "'"]
    /// Delimiters of strings that may span lines (`"""`, a backtick template).
    var multilineStrings: [String] = []
    /// Single quotes are character literals (`'a'`), so a lone one (a Rust lifetime) is not a string.
    var charLiterals = false
    /// A quote right after a letter is an apostrophe (`don't` in YAML or a shell script), not a string.
    var quotesNeedBoundary = false
    /// Capitalized identifiers are types (Swift, Java, Rust...).
    var capitalizedTypes = false
    /// `@name` is an attribute or decorator.
    var attributes = false
    /// A line starting with `#` is a preprocessor directive (C family).
    var preprocessor = false
    /// Keywords match regardless of case (SQL).
    var caseInsensitive = false
    /// `$` may appear in identifiers (JavaScript, PHP, shell variables).
    var dollarIdentifiers = false
    /// HTML/XML: color tags and attribute values, leave the text between them alone.
    var markup = false

    init(_ name: String) { self.name = name }
}

extension SyntaxLanguage {
    /// The language of a file, from its extension or name, or nil for anything that is not code
    /// (plain text, PDFs and other documents, Markdown).
    public static func forPath(_ path: String) -> SyntaxLanguage? {
        let name = (path as NSString).lastPathComponent.lowercased()
        switch name {
        case "dockerfile", "containerfile": return dockerfile
        case "makefile", "gnumakefile", ".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".env": return shell
        default: return byExtension[(name as NSString).pathExtension]
        }
    }

    static let byExtension: [String: SyntaxLanguage] = {
        var map: [String: SyntaxLanguage] = [:]
        func add(_ lang: SyntaxLanguage, _ exts: String...) { for e in exts { map[e] = lang } }
        add(swift, "swift")
        add(c, "c", "h")
        add(cpp, "cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino")
        add(objc, "m", "mm")
        add(csharp, "cs")
        add(java, "java")
        add(kotlin, "kt", "kts")
        add(go, "go")
        add(rust, "rs")
        add(javascript, "js", "jsx", "mjs", "cjs")
        add(typescript, "ts", "tsx", "mts", "cts")
        add(python, "py", "pyi", "pyw")
        add(ruby, "rb", "rake", "gemspec")
        add(php, "php")
        add(shell, "sh", "bash", "zsh", "fish", "ksh", "command")
        add(sql, "sql")
        add(lua, "lua")
        add(json, "json", "jsonc", "json5")
        add(yaml, "yaml", "yml")
        add(toml, "toml", "ini", "cfg", "conf")
        add(css, "css", "scss", "sass", "less")
        add(markupLanguage, "html", "htm", "xml", "xhtml", "svg", "plist", "vue", "xib", "storyboard")
        return map
    }()

    private static func words(_ s: String) -> Set<String> { Set(s.split(separator: " ").map(String.init)) }

    private static func cFamily(_ name: String, keywords: String, types: String = "") -> SyntaxLanguage {
        var l = SyntaxLanguage(name)
        l.keywords = words(keywords)
        l.types = words(types)
        l.lineComments = ["//"]
        l.blockComment = ("/*", "*/")
        l.charLiterals = true
        return l
    }

    static let cKeywords = "auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while true false NULL"
    static let cTypes = "void char short int long float double signed unsigned bool size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t uintptr_t FILE"

    static let c: SyntaxLanguage = {
        var l = cFamily("c", keywords: cKeywords, types: cTypes)
        l.preprocessor = true
        return l
    }()

    static let cpp: SyntaxLanguage = {
        var l = cFamily("cpp", keywords: cKeywords + " alignas alignof catch class constexpr consteval constinit decltype delete explicit export final friend mutable namespace new noexcept nullptr operator override private protected public static_assert template this throw try typeid typename using virtual co_await co_return co_yield concept requires", types: cTypes + " auto wchar_t char8_t char16_t char32_t string vector map")
        l.preprocessor = true
        return l
    }()

    static let objc: SyntaxLanguage = {
        var l = cFamily("objc", keywords: cKeywords + " self super nil Nil YES NO id instancetype @interface @implementation @end @property @protocol @class @selector @synthesize @autoreleasepool", types: cTypes + " BOOL SEL IMP NSInteger NSUInteger CGFloat")
        l.preprocessor = true
        l.capitalizedTypes = true
        l.attributes = true
        return l
    }()

    static let csharp: SyntaxLanguage = {
        var l = cFamily("csharp", keywords: "abstract as async await base break case catch checked class const continue default delegate do else enum event explicit extern false finally fixed for foreach get goto if implicit in init interface internal is lock namespace new null operator out override params private protected public readonly record ref return sealed set sizeof stackalloc static struct switch this throw true try typeof unchecked unsafe using var virtual volatile when where while yield", types: "bool byte char decimal double dynamic float int long object sbyte short string uint ulong ushort void")
        l.capitalizedTypes = true
        l.preprocessor = true
        return l
    }()

    static let java: SyntaxLanguage = {
        var l = cFamily("java", keywords: "abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public record return sealed static strictfp super switch synchronized this throw throws transient try var void volatile while yield true false null permits non-sealed", types: "boolean byte char double float int long short")
        l.capitalizedTypes = true
        l.attributes = true
        return l
    }()

    static let kotlin: SyntaxLanguage = {
        var l = cFamily("kotlin", keywords: "abstract actual annotation as break by catch class companion const constructor continue crossinline data do else enum expect external false final finally for fun get if import in infix init inline inner interface internal is lateinit noinline null object open operator out override package private protected public reified return sealed set super suspend tailrec this throw true try typealias val var vararg when where while")
        l.capitalizedTypes = true
        l.attributes = true
        l.multilineStrings = ["\"\"\""]
        return l
    }()

    static let go: SyntaxLanguage = {
        var l = cFamily("go", keywords: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota", types: "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any")
        l.multilineStrings = ["`"]
        return l
    }()

    static let rust: SyntaxLanguage = {
        var l = cFamily("rust", keywords: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while", types: "bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize")
        l.capitalizedTypes = true
        return l
    }()

    static let swift: SyntaxLanguage = {
        var l = cFamily("swift", keywords: "actor any associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough false fileprivate final for func guard if import in indirect init inout internal is lazy let mutating nil nonisolated open operator override private protocol public repeat rethrows return self Self some static struct subscript super switch throw throws true try typealias var weak unowned where while consuming borrowing sending")
        l.capitalizedTypes = true
        l.attributes = true
        l.preprocessor = true // #if os(macOS)
        l.charLiterals = false
        l.quotes = ["\""]
        l.multilineStrings = ["\"\"\""]
        return l
    }()

    static let javascriptKeywords = "async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield"

    static let javascript: SyntaxLanguage = {
        var l = cFamily("javascript", keywords: javascriptKeywords)
        l.charLiterals = false
        l.quotes = ["\"", "'"]
        l.multilineStrings = ["`"]
        l.dollarIdentifiers = true
        return l
    }()

    static let typescript: SyntaxLanguage = {
        var l = javascript
        l.name = "typescript"
        l.keywords.formUnion(words("abstract as asserts declare enum implements infer interface is keyof namespace never private protected public readonly satisfies type unique"))
        l.types = words("any boolean number string symbol object unknown bigint void")
        l.capitalizedTypes = true
        l.attributes = true
        return l
    }()

    static let python: SyntaxLanguage = {
        var l = SyntaxLanguage("python")
        l.keywords = words("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self")
        l.types = words("int float str bytes bool list dict set tuple object")
        l.lineComments = ["#"]
        l.multilineStrings = ["\"\"\"", "'''"]
        l.attributes = true
        l.capitalizedTypes = true
        return l
    }()

    static let ruby: SyntaxLanguage = {
        var l = SyntaxLanguage("ruby")
        l.keywords = words("alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor attr_reader attr_writer private protected public")
        l.lineComments = ["#"]
        l.capitalizedTypes = true
        return l
    }()

    static let php: SyntaxLanguage = {
        var l = cFamily("php", keywords: "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new null or print private protected public readonly require require_once return static switch throw trait true false try unset use var while xor yield")
        l.lineComments = ["//", "#"]
        l.charLiterals = false
        l.dollarIdentifiers = true
        l.capitalizedTypes = true
        return l
    }()

    static let shell: SyntaxLanguage = {
        var l = SyntaxLanguage("shell")
        l.keywords = words("if then else elif fi case esac for while until do done in function return local export readonly declare set unset shift exit source alias echo cd")
        l.lineComments = ["#"]
        l.dollarIdentifiers = true
        l.quotesNeedBoundary = true
        return l
    }()

    static let dockerfile: SyntaxLanguage = {
        var l = shell
        l.name = "dockerfile"
        l.keywords.formUnion(words("FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS"))
        return l
    }()

    static let sql: SyntaxLanguage = {
        var l = SyntaxLanguage("sql")
        l.keywords = words("select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer full cross on as group by order having limit offset union all distinct case when then else end is null like in between exists begin commit rollback transaction if default unique check constraint with returning asc desc trigger")
        l.types = words("int integer bigint smallint real double float text varchar char blob boolean date timestamp numeric decimal")
        l.lineComments = ["--"]
        l.blockComment = ("/*", "*/")
        l.caseInsensitive = true
        return l
    }()

    static let lua: SyntaxLanguage = {
        var l = SyntaxLanguage("lua")
        l.keywords = words("and break do else elseif end false for function goto if in local nil not or repeat return then true until while")
        l.lineComments = ["--"]
        l.blockComment = ("--[[", "]]")
        return l
    }()

    static let json: SyntaxLanguage = {
        var l = SyntaxLanguage("json")
        l.keywords = words("true false null")
        l.lineComments = ["//"]
        l.blockComment = ("/*", "*/")
        l.quotes = ["\""]
        return l
    }()

    static let yaml: SyntaxLanguage = {
        var l = SyntaxLanguage("yaml")
        l.keywords = words("true false null yes no on off")
        l.lineComments = ["#"]
        l.quotesNeedBoundary = true
        return l
    }()

    static let toml: SyntaxLanguage = {
        var l = SyntaxLanguage("toml")
        l.keywords = words("true false")
        l.lineComments = ["#", ";"]
        l.multilineStrings = ["\"\"\"", "'''"]
        l.quotesNeedBoundary = true
        return l
    }()

    static let css: SyntaxLanguage = {
        var l = SyntaxLanguage("css")
        l.keywords = words("important inherit initial unset none auto")
        l.lineComments = ["//"]
        l.blockComment = ("/*", "*/")
        l.attributes = true
        return l
    }()

    static let markupLanguage: SyntaxLanguage = {
        var l = SyntaxLanguage("markup")
        l.blockComment = ("<!--", "-->")
        l.markup = true
        return l
    }()
}

/// Colors a file line by line, carrying open block comments, multi-line strings and markup tags
/// from one line to the next. Lines must be fed in order; a preview that starts mid-file starts
/// outside any comment or string.
public struct SyntaxHighlighter {
    public let language: SyntaxLanguage

    private enum State: Equatable {
        case code
        case blockComment
        case string(close: [UInt16])
        case tag
    }

    private var state: State = .code

    public init(language: SyntaxLanguage) {
        self.language = language
    }

    /// The tokens of the next line, in order and not overlapping.
    public mutating func tokens(_ line: String) -> [SyntaxToken] {
        let u = Array(line.utf16)
        var out: [SyntaxToken] = []
        var i = 0
        let n = u.count
        let lang = language

        func at(_ s: [UInt16], _ p: Int) -> Bool {
            guard p + s.count <= n, !s.isEmpty else { return false }
            for k in 0..<s.count where u[p + k] != s[k] { return false }
            return true
        }
        func find(_ s: [UInt16], from p: Int) -> Int? {
            var q = p
            while q + s.count <= n {
                if at(s, q) { return q }
                q += 1
            }
            return nil
        }
        /// End of a string closed by `close`, starting after its opening; nil if it runs past the line.
        func stringEnd(_ close: [UInt16], from p: Int) -> Int? {
            var q = p
            while q < n {
                if u[q] == 92 { q += 2; continue } // backslash escape
                if at(close, q) { return q + close.count }
                q += 1
            }
            return nil
        }

        let blockOpen = lang.blockComment.map { Array($0.open.utf16) }
        let blockClose = lang.blockComment.map { Array($0.close.utf16) }
        let lineComments = lang.lineComments.map { Array($0.utf16) }
        let multiline = lang.multilineStrings.map { Array($0.utf16) }

        // Finish what the previous line left open.
        switch state {
        case .blockComment:
            if let close = blockClose, let e = find(close, from: 0) {
                out.append(SyntaxToken(.comment, 0, e + close.count))
                i = e + close.count
                state = .code
            } else {
                if n > 0 { out.append(SyntaxToken(.comment, 0, n)) }
                return out
            }
        case let .string(close):
            if let e = stringEnd(close, from: 0) {
                out.append(SyntaxToken(.string, 0, e))
                i = e
                state = .code
            } else {
                if n > 0 { out.append(SyntaxToken(.string, 0, n)) }
                return out
            }
        case .tag, .code:
            break
        }

        if lang.markup { return markupTokens(u, from: i, into: out) }

        // A preprocessor line is one token (up to a trailing comment).
        if lang.preprocessor {
            var q = i
            while q < n, u[q] == 32 || u[q] == 9 { q += 1 }
            if q < n, u[q] == 35 /* # */ {
                var e = n
                for lc in lineComments { if let c = find(lc, from: q) { e = min(e, c) } }
                if let bo = blockOpen, let c = find(bo, from: q) { e = min(e, c) }
                out.append(SyntaxToken(.meta, q, e))
                i = e
            }
        }

        while i < n {
            let c = u[i]
            // Comments; block first, since Lua's --[[ starts with its line comment --.
            if let bo = blockOpen, let bc = blockClose, at(bo, i) {
                if let e = find(bc, from: i + bo.count) {
                    out.append(SyntaxToken(.comment, i, e + bc.count))
                    i = e + bc.count
                    continue
                }
                out.append(SyntaxToken(.comment, i, n))
                state = .blockComment
                return out
            }
            if lineComments.contains(where: { at($0, i) }) {
                out.append(SyntaxToken(.comment, i, n))
                return out
            }
            // Strings that may span lines, longest delimiter first (""" before ").
            if let m = multiline.first(where: { at($0, i) }) {
                if let e = stringEnd(m, from: i + m.count) {
                    out.append(SyntaxToken(.string, i, e))
                    i = e
                    continue
                }
                out.append(SyntaxToken(.string, i, n))
                state = .string(close: m)
                return out
            }
            // One-line strings.
            if c < 128, lang.quotes.contains(Character(Unicode.Scalar(UInt8(c)))),
               !(lang.quotesNeedBoundary && i > 0 && isIdent(u[i - 1])) {
                if c == 39, lang.charLiterals {
                    // 'a', '\n', '\u{1F600}' are characters; a lone one ('a in Rust) is not a string.
                    if let e = charLiteralEnd(u, i) {
                        out.append(SyntaxToken(.string, i, e))
                        i = e
                    } else {
                        i += 1
                    }
                    continue
                }
                let e = stringEnd([c], from: i + 1) ?? n
                out.append(SyntaxToken(.string, i, e))
                i = e
                continue
            }
            // Attributes and decorators.
            if c == 64 /* @ */, lang.attributes, i + 1 < n, isIdentStart(u[i + 1]) {
                var e = i + 1
                while e < n, isIdent(u[e]) { e += 1 }
                out.append(SyntaxToken(.meta, i, e))
                i = e
                continue
            }
            // Numbers, not the digits inside an identifier.
            if isDigit(c) || (c == 46 && i + 1 < n && isDigit(u[i + 1])) {
                var e = i + 1
                while e < n, isIdent(u[e]) || u[e] == 46 { e += 1 }
                out.append(SyntaxToken(.number, i, e))
                i = e
                continue
            }
            // Words.
            if isIdentStart(c) || (lang.dollarIdentifiers && c == 36) {
                var e = i + 1
                while e < n, isIdent(u[e]) || (lang.dollarIdentifiers && u[e] == 36) { e += 1 }
                // Ruby's `defined?` and similar keep their question mark.
                if e < n, u[e] == 63, lang.keywords.contains(String(decoding: u[i..<e + 1], as: UTF16.self)) { e += 1 }
                let word = String(decoding: u[i..<e], as: UTF16.self)
                let key = lang.caseInsensitive ? word.lowercased() : word
                // `.default` and `obj.type` are member names, not keywords.
                let afterDot = i > 0 && u[i - 1] == 46 && !(i > 1 && u[i - 2] == 46)
                if !afterDot, lang.keywords.contains(key) {
                    out.append(SyntaxToken(.keyword, i, e))
                } else if lang.types.contains(key) || (lang.capitalizedTypes && c >= 65 && c <= 90 && !afterDot) {
                    out.append(SyntaxToken(.type, i, e))
                }
                i = e
                continue
            }
            i += 1
        }
        return out
    }

    /// HTML and XML: tag names, attribute values and comments; the text between tags stays plain.
    private mutating func markupTokens(_ u: [UInt16], from start: Int, into initial: [SyntaxToken]) -> [SyntaxToken] {
        var out = initial
        let n = u.count
        var i = start
        let open = Array("<!--".utf16), close = Array("-->".utf16)
        func at(_ s: [UInt16], _ p: Int) -> Bool {
            guard p + s.count <= n else { return false }
            for k in 0..<s.count where u[p + k] != s[k] { return false }
            return true
        }
        while i < n {
            if state == .tag {
                let c = u[i]
                if c == 62 /* > */ { state = .code; i += 1; continue }
                if c == 34 || c == 39 {
                    var e = i + 1
                    while e < n, u[e] != c { e += 1 }
                    if e < n { e += 1 }
                    out.append(SyntaxToken(.string, i, e))
                    i = e
                    continue
                }
                if isIdentStart(c) {
                    var e = i + 1
                    while e < n, isIdent(u[e]) || u[e] == 45 || u[e] == 58 { e += 1 }
                    out.append(SyntaxToken(.type, i, e))
                    i = e
                    continue
                }
                i += 1
                continue
            }
            if at(open, i) {
                var e = i + open.count
                while e < n, !at(close, e) { e += 1 }
                if e < n {
                    out.append(SyntaxToken(.comment, i, e + close.count))
                    i = e + close.count
                    continue
                }
                out.append(SyntaxToken(.comment, i, n))
                state = .blockComment
                return out
            }
            if u[i] == 60 /* < */, i + 1 < n, isIdentStart(u[i + 1]) || u[i + 1] == 47 || u[i + 1] == 33 || u[i + 1] == 63 {
                var s = i + 1
                if u[s] == 47 || u[s] == 33 || u[s] == 63 { s += 1 }
                var e = s
                while e < n, isIdent(u[e]) || u[e] == 45 || u[e] == 58 || u[e] == 46 { e += 1 }
                if e > s { out.append(SyntaxToken(.meta, s, e)) }
                state = .tag
                i = e
                continue
            }
            i += 1
        }
        return out
    }
}

/// End of the character literal opening at `i`, or nil if the quote does not start one.
private func charLiteralEnd(_ u: [UInt16], _ i: Int) -> Int? {
    let n = u.count
    var q = i + 1
    guard q < n else { return nil }
    if u[q] == 92 { // an escape: '\n', '\x41', '\u{1F600}'
        q += 2
        while q < n, q - i <= 12, u[q] != 39 { q += 1 }
        return q < n && u[q] == 39 ? q + 1 : nil
    }
    q += UTF16.isLeadSurrogate(u[q]) ? 2 : 1
    return q < n && u[q] == 39 ? q + 1 : nil
}

private func isDigit(_ c: UInt16) -> Bool { c >= 48 && c <= 57 }
private func isIdentStart(_ c: UInt16) -> Bool { (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 || c > 127 }
private func isIdent(_ c: UInt16) -> Bool { isIdentStart(c) || isDigit(c) }
