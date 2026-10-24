#if os(macOS)
import AppKit
import ZSearchKit

/// A value made on one thread and only read after it is handed over (an `NSAttributedString` or
/// `PDFDocument` nobody changes afterwards).
struct Handover<Value>: @unchecked Sendable {
    let value: Value
}

/// Whether a document cache has a file's document ready, knows it can't be read, or hasn't tried.
enum DocumentState {
    case ready
    case failed
    case unknown
}

/// Styled preview text for recent previews, made off the main thread, so moving to a file only
/// puts its text in the view.
@MainActor
final class TextPreviews {
    static let shared = TextPreviews()

    /// What `StyledText` depends on: a jump to another match of the same lines needs no new text.
    struct Key: Hashable {
        let path: String
        let isDir: Bool
        let lines: [PreviewLine]
        let matchLines: [Int]

        init(_ p: FilePreview) {
            path = p.path
            isDir = p.isDir
            lines = p.lines
            matchLines = p.matchLines
        }

        // A few fields only: hashing every line on each lookup would cost what caching saves.
        func hash(into hasher: inout Hasher) {
            hasher.combine(path)
            hasher.combine(lines.count)
            hasher.combine(lines.first?.n)
            hasher.combine(matchLines.count)
        }
    }

    private var cache: [Key: StyledText] = [:]
    private var order: [Key] = []
    private var running: [Key: Task<StyledText, Never>] = [:]
    private let limit = 32

    func styled(for p: FilePreview) -> StyledText? {
        cache[Key(p)]
    }

    func prepare(_ p: FilePreview) async {
        let key = Key(p)
        if cache[key] != nil { return }
        if let task = running[key] {
            _ = await task.value
            return
        }
        let task = Task.detached(priority: .userInitiated) { StyledText(p) }
        running[key] = task
        let styled = await task.value
        running[key] = nil
        if cache.updateValue(styled, forKey: key) == nil { order.append(key) }
        while order.count > limit { cache[order.removeFirst()] = nil }
    }
}

/// Readies what the preview pane shows for a preview off the main thread (a PDF opened, a Word
/// file read, text styled), so the main thread only puts it on screen.
@MainActor
enum PreviewPreparation {
    private enum Step {
        case pdf
        case word
        case text
    }

    static func isReady(_ p: FilePreview) -> Bool {
        next(p) == nil
    }

    static func prepare(_ p: FilePreview) async {
        // Each step settles what it is for (a document opened or failed, text styled): at most
        // a document, then the text if the document can't be shown.
        for _ in 0..<3 {
            guard !Task.isCancelled, let step = next(p) else { return }
            switch step {
            case .pdf: await PDFDocuments.shared.load(p)
            case .word: await WordDocuments.shared.load(p)
            case .text: await TextPreviews.shared.prepare(p)
            }
        }
    }

    /// Style the text of a preview that may be shown next (a neighbour of the selection), if it
    /// shows as text. Documents aren't opened ahead: they are big, and few are kept.
    static func prepareAhead(_ p: FilePreview) async {
        if next(p) == .text { await TextPreviews.shared.prepare(p) }
    }

    /// Whether showing `p` waits on a document to be opened (a setting switched to show it, say).
    static func needsDocument(_ p: FilePreview) -> Bool {
        switch next(p) {
        case .pdf, .word: return true
        case .text, nil: return false
        }
    }

    /// What `PreviewPane` would still do on the main thread to show `p`; it decides the same way.
    private static func next(_ p: FilePreview) -> Step? {
        let defaults = UserDefaults.standard
        if p.kind == "pdf", p.contentAllowed != false {
            switch PDFDocuments.shared.state(of: p) {
            case .unknown: return .pdf
            case .ready: if !defaults.bool(forKey: AppSettings.pdfShowsText) || p.message != nil { return nil }
            case .failed: break
            }
        } else if WordDocuments.handles(p), !defaults.bool(forKey: AppSettings.documentShowsText) || p.message != nil {
            switch WordDocuments.shared.state(of: p) {
            case .unknown: return .word
            case .ready: return nil
            case .failed: break
            }
        }
        guard p.message == nil else { return nil }
        let preference = QuickLookPreview.isOffice(p) ? AppSettings.officeShowsText
            : (p.kind == "audio" || p.kind == "video" ? AppSettings.mediaShowsTranscript : AppSettings.imageShowsText)
        if QuickLookPreview.showsFile(p, showsText: defaults.bool(forKey: preference)),
           FileManager.default.fileExists(atPath: p.path) { return nil }
        return TextPreviews.shared.styled(for: p) == nil ? .text : nil
    }
}
#endif
