#if os(macOS)
import AppKit
import PDFKit
import Quartz
import SwiftUI
import ZSearchKit

/// Identifies a file's contents: a file that changed on disk (new size or modification time) is
/// opened again.
private struct PDFKey: Hashable {
    var path: String
    var size: Int
    var mtime: Double

    init(_ p: FilePreview) {
        path = p.path
        size = p.size
        mtime = p.mtime
    }
}

/// Opened PDFs, kept for the few most recent files so moving back and forth through the results
/// doesn't reopen them. `load` opens a file and finds its matches off the main thread, before the
/// document is shown. That reads the text of the pages it needs, which PDFKit keeps with the
/// document, so highlighting them on screen afterwards is quick.
@MainActor
final class PDFDocuments {
    static let shared = PDFDocuments()

    /// What `load` makes: the document, and the matches of the preview it was opened for.
    private struct Opened {
        let document: PDFDocument
        let preview: FilePreview
        let marks: PDFMarks
    }

    private var cache: [PDFKey: PDFDocument] = [:]
    private var order: [PDFKey] = []
    /// Files that could not be opened, and when; tried again after `retryAfter` (the file may
    /// have been read halfway through a save).
    private var failed: [PDFKey: Date] = [:]
    private static let retryAfter: TimeInterval = 30
    private var opening: [PDFKey: Task<Handover<Opened?>, Never>] = [:]
    private let limit = 4
    /// Recent previews' matches, newest last.
    private var recentMarks: [(preview: FilePreview, marks: PDFMarks)] = []

    /// The document for a preview, if `load` opened it.
    func document(for p: FilePreview) -> PDFDocument? {
        let key = PDFKey(p)
        guard let doc = cache[key] else { return nil }
        if order.last != key {
            order.removeAll { $0 == key }
            order.append(key)
        }
        return doc
    }

    /// Where a preview's matches are, if `load` found them.
    func marks(for p: FilePreview) -> PDFMarks? {
        recentMarks.last { $0.preview == p }?.marks
    }

    /// An open document counts as ready for any preview of its file. Once it may be on screen it
    /// is only used on the main thread, where the view finds the matches of another query or
    /// match; the pages read for the earlier ones need not be read again.
    func state(of p: FilePreview) -> DocumentState {
        let key = PDFKey(p)
        if cache[key] != nil { return .ready }
        if let at = failed[key], Date().timeIntervalSince(at) < Self.retryAfter { return .failed }
        return .unknown
    }

    /// Open the preview's PDF and find its matches, off the main thread. A file that can't be
    /// opened (gone, damaged, or password-protected) is marked failed.
    func load(_ p: FilePreview) async {
        let key = PDFKey(p)
        guard cache[key] == nil else { return }
        let task = opening[key] ?? Task.detached(priority: .userInitiated) {
            guard let doc = PDFDocument(url: URL(fileURLWithPath: key.path)), !doc.isLocked, doc.pageCount > 0 else {
                return Handover<Opened?>(value: nil)
            }
            return Handover<Opened?>(value: Opened(document: doc, preview: p, marks: PDFMatching.marks(for: p, in: doc)))
        }
        opening[key] = task
        let opened = await task.value.value
        opening[key] = nil
        guard let opened else {
            if failed.count > 64 { failed.removeAll() }
            failed[key] = Date()
            return
        }
        failed[key] = nil
        // Another load of the same file (for another preview) waited on the same task.
        guard cache[key] == nil else { return }
        cache[key] = opened.document
        order.append(key)
        while order.count > limit { cache[order.removeFirst()] = nil }
        recentMarks.append((opened.preview, opened.marks))
        if recentMarks.count > 8 { recentMarks.removeFirst() }
    }
}
/// Where the focused match is: its page, how far that is from the page the indexed text's page
/// breaks point to, and its place on the page when it could be found there.
struct PDFFocus: Sendable, Equatable {
    var page: Int
    var shift: Int
    var range: NSRange?
}

struct PDFMark: Sendable, Equatable {
    var page: Int
    var range: NSRange
}

/// A preview's focused match and the matched words to highlight, in page order.
struct PDFMarks: Sendable {
    var focus: PDFFocus
    var highlights: [PDFMark]
}

/// Finding matches in a PDF's text. Works on any thread, on a document no other thread uses.
enum PDFMatching {
    static let highlightLimit = 2000

    static func marks(for p: FilePreview, in document: PDFDocument) -> PDFMarks {
        let focus = focus(of: p, in: document)
        return PDFMarks(focus: focus, highlights: highlights(for: p, focus: focus, in: document))
    }

    /// The page of the focus line. Its indexed text counts pages by their form feeds, which can
    /// miss pages without text (a blank or scanned cover, say; older indexes dropped those), so
    /// the line is looked for on that page and then on the pages after it, the way it can only
    /// have moved, and on a few pages before it in case PDFKit splits the pages differently.
    static func focus(of p: FilePreview, in document: PDFDocument) -> PDFFocus {
        let count = document.pageCount
        let estimate = min(PageMap.page(ofLine: p.focusLine, pageStarts: p.pageStarts), count - 1)
        let candidates = Array(estimate..<min(count, estimate + 40)) + Array(max(0, estimate - 3)..<estimate).reversed()
        for index in candidates {
            guard let text = document.page(at: index)?.string else { continue }
            if let range = PageMap.locate(focusOf: p, in: text) {
                return PDFFocus(page: index, shift: index - estimate, range: range)
            }
        }
        return PDFFocus(page: estimate, shift: 0, range: nil)
    }

    /// The matched words on the pages that have matches (the focus page first, so it is never
    /// cut by the limit), returned in page order. Only those pages are searched, so a long
    /// document doesn't take long.
    static func highlights(for p: FilePreview, focus: PDFFocus, in document: PDFDocument) -> [PDFMark] {
        let terms = PageMap.matchedTerms(p)
        guard !terms.isEmpty else { return [] }
        var pages = [focus.page]
        for mapped in PageMap.pages(ofLines: p.matchLines, pageStarts: p.pageStarts).prefix(200) {
            // Pages missing before the focus line are missing before the later matches too.
            for page in Set([mapped, mapped + focus.shift]) where page >= 0 && page < document.pageCount && !pages.contains(page) {
                pages.append(page)
            }
        }

        var out: [PDFMark] = []
        for index in pages {
            guard let page = document.page(at: index), let string = page.string else { continue }
            let text = string as NSString
            var taken: [NSRange] = []
            // Longest terms first, and a shorter one inside a longer match is not marked twice.
            for term in terms {
                var from = 0
                while from < text.length, out.count < highlightLimit {
                    let found = text.range(of: term, options: [.caseInsensitive, .diacriticInsensitive], range: NSRange(location: from, length: text.length - from))
                    guard found.location != NSNotFound, found.length > 0 else { break }
                    from = found.location + found.length
                    guard !taken.contains(where: { NSIntersectionRange($0, found).length > 0 }) else { continue }
                    taken.append(found)
                    out.append(PDFMark(page: index, range: found))
                }
            }
        }
        return out.sorted { ($0.page, $0.range.location) < ($1.page, $1.range.location) }
    }
}

/// The PDF itself, rendered page by page, opened at the page of the match with the matching
/// words highlighted on the pages that have matches.
struct PDFPreviewView: NSViewRepresentable {
    let preview: FilePreview
    let document: PDFDocument

    final class Coordinator {
        var shown: FilePreview?
        /// The highlights on screen: another match in the same file usually has the same ones.
        var highlights: [PDFMark]?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.autoScales = true
        view.displaysPageBreaks = true
        view.backgroundColor = .clear
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
        let coordinator = context.coordinator
        let previous = coordinator.shown
        guard previous != preview || view.document !== document else { return }
        coordinator.shown = preview

        let sameFile = view.document === document
        if !sameFile {
            view.document = document
            coordinator.highlights = nil
        }
        let marks = PDFDocuments.shared.marks(for: preview) ?? PDFMatching.marks(for: preview, in: document)
        if marks.highlights != coordinator.highlights {
            coordinator.highlights = marks.highlights
            let color = NSColor.systemYellow.withAlphaComponent(0.5)
            let selections = marks.highlights.compactMap { mark -> PDFSelection? in
                guard let selection = document.page(at: mark.page)?.selection(for: mark.range) else { return nil }
                selection.color = color
                return selection
            }
            view.highlightedSelections = selections.isEmpty ? nil : selections
        }
        // A refresh of the same file keeps the reader's place; anything else goes to the match.
        if sameFile, previous?.id == preview.id, previous?.focusLine == preview.focusLine { return }
        Self.reveal(marks, in: view)
        // Layout may not be final on the first pass (a newly shown pane has no size yet).
        DispatchQueue.main.async { Self.reveal(marks, in: view) }
    }

    /// Scroll to the focused match; if it couldn't be placed on the page, to the earliest
    /// highlight there in reading order, or else to the top of the page.
    static func reveal(_ marks: PDFMarks, in view: PDFView) {
        let focus = marks.focus
        guard let document = view.document, let page = document.page(at: focus.page) else { return }
        let range = focus.range ?? marks.highlights.first { $0.page == focus.page }?.range
        if let range, let selection = page.selection(for: range) {
            // Leave some room above the match rather than pinning it to the top edge.
            var rect = selection.bounds(for: page)
            rect.origin.y += 120
            view.go(to: rect, on: page)
        } else {
            view.go(to: page)
        }
    }
}/// Any other file, as Quick Look shows it: spreadsheets, presentations, images, media, fonts, and files without text.
struct QuickLookView: NSViewRepresentable {
    let url: URL

    final class Coordinator {
        var preview: QLPreviewView?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    // QLPreviewView's initializers can fail, so it sits in a plain container view.
    func makeNSView(context: Context) -> NSView {
        let container = NSView(frame: .zero)
        if let view = QLPreviewView(frame: .zero, style: .normal) {
            view.autostarts = true
            view.shouldCloseWithWindow = false
            view.autoresizingMask = [.width, .height]
            container.addSubview(view)
            context.coordinator.preview = view
        }
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        guard let view = context.coordinator.preview else { return }
        view.frame = container.bounds
        if (view.previewItem as? NSURL) as URL? != url { view.previewItem = url as NSURL }
    }

    static func dismantleNSView(_ container: NSView, coordinator: Coordinator) {
        coordinator.preview?.close()
        coordinator.preview = nil
    }
}
#endif
