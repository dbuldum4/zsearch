#if os(macOS)
import AppKit
import PDFKit
import Quartz
import SwiftUI
import ZSearchKit

/// Opened PDFs, kept for the few most recent files so moving back and forth through the results
/// doesn't reopen them. A file that changed on disk (new size or modification time) is reopened.
@MainActor
final class PDFDocuments {
    static let shared = PDFDocuments()

    private struct Key: Hashable {
        var path: String
        var size: Int
        var mtime: Double
    }

    private var cache: [Key: PDFDocument] = [:]
    private var order: [Key] = []
    private let limit = 4

    /// The document for a preview, or nil if it can't be opened (gone, damaged, or password-protected).
    func document(for p: FilePreview) -> PDFDocument? {
        let key = Key(path: p.path, size: p.size, mtime: p.mtime)
        if let doc = cache[key] {
            order.removeAll { $0 == key }
            order.append(key)
            return doc
        }
        guard let doc = PDFDocument(url: URL(fileURLWithPath: p.path)), !doc.isLocked, doc.pageCount > 0 else { return nil }
        cache[key] = doc
        order.append(key)
        while order.count > limit { cache[order.removeFirst()] = nil }
        return doc
    }
}

/// The PDF itself, rendered page by page, opened at the page of the match with the matching
/// words highlighted on the pages that have matches.
struct PDFPreviewView: NSViewRepresentable {
    let preview: FilePreview
    let document: PDFDocument

    final class Coordinator {
        var shown: FilePreview?
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
        let previous = context.coordinator.shown
        guard previous != preview || view.document !== document else { return }
        context.coordinator.shown = preview

        let sameFile = view.document === document
        if !sameFile { view.document = document }
        let focus = Self.focus(of: preview, in: document)
        let highlights = Self.highlights(for: preview, focus: focus, in: document)
        view.highlightedSelections = highlights.isEmpty ? nil : highlights.map(\.selection)
        // A refresh of the same file keeps the reader's place; anything else goes to the match.
        if sameFile, previous?.id == preview.id, previous?.focusLine == preview.focusLine { return }
        Self.reveal(focus, highlights: highlights, in: view)
        // Layout may not be final on the first pass (a newly shown pane has no size yet).
        DispatchQueue.main.async { Self.reveal(focus, highlights: highlights, in: view) }
    }

    /// Where the focused match is: its page, how far that is from the page the indexed text's page
    /// breaks point to, and its place on the page when it could be found there.
    struct Focus {
        var page: Int
        var shift: Int
        var range: NSRange?
    }

    struct Highlight {
        var page: Int
        var range: NSRange
        var selection: PDFSelection
    }

    /// The page of the focus line. Its indexed text counts pages by their form feeds, which can
    /// miss pages without text (a blank or scanned cover, say; older indexes dropped those), so
    /// the line is looked for on that page and then on the pages after it, the way it can only
    /// have moved, and on a few pages before it in case PDFKit splits the pages differently.
    static func focus(of p: FilePreview, in document: PDFDocument) -> Focus {
        let count = document.pageCount
        let estimate = min(PageMap.page(ofLine: p.focusLine, pageStarts: p.pageStarts), count - 1)
        let candidates = Array(estimate..<min(count, estimate + 40)) + Array(max(0, estimate - 3)..<estimate).reversed()
        for index in candidates {
            guard let text = document.page(at: index)?.string else { continue }
            if let range = PageMap.locate(focusOf: p, in: text) {
                return Focus(page: index, shift: index - estimate, range: range)
            }
        }
        return Focus(page: estimate, shift: 0, range: nil)
    }

    /// The matched words on the pages that have matches (the focus page first). Only those pages
    /// are searched, so a long document doesn't stall the switch to it.
    static func highlights(for p: FilePreview, focus: Focus, in document: PDFDocument) -> [Highlight] {
        let terms = PageMap.matchedTerms(p)
        guard !terms.isEmpty else { return [] }
        var pages = [focus.page]
        for mapped in PageMap.pages(ofLines: p.matchLines, pageStarts: p.pageStarts).prefix(200) {
            // Pages missing before the focus line are missing before the later matches too.
            for page in Set([mapped, mapped + focus.shift]) where page >= 0 && page < document.pageCount && !pages.contains(page) {
                pages.append(page)
            }
        }

        let color = NSColor.systemYellow.withAlphaComponent(0.5)
        var out: [Highlight] = []
        for index in pages {
            guard let page = document.page(at: index), let string = page.string else { continue }
            let text = string as NSString
            var taken: [NSRange] = []
            // Longest terms first, and a shorter one inside a longer match is not marked twice.
            for term in terms {
                var from = 0
                while from < text.length, out.count < 2000 {
                    let found = text.range(of: term, options: [.caseInsensitive, .diacriticInsensitive], range: NSRange(location: from, length: text.length - from))
                    guard found.location != NSNotFound, found.length > 0 else { break }
                    from = found.location + found.length
                    guard !taken.contains(where: { NSIntersectionRange($0, found).length > 0 }) else { continue }
                    taken.append(found)
                    guard let selection = page.selection(for: found) else { continue }
                    selection.color = color
                    out.append(Highlight(page: index, range: found, selection: selection))
                }
            }
        }
        return out
    }

    /// Scroll to the focused match; if it couldn't be placed on the page, to the earliest
    /// highlight there in reading order, or else to the top of the page.
    static func reveal(_ focus: Focus, highlights: [Highlight], in view: PDFView) {
        guard let document = view.document, let page = document.page(at: focus.page) else { return }
        let earliest = highlights.filter { $0.page == focus.page }.min { $0.range.location < $1.range.location }
        let range = focus.range ?? earliest?.range
        if let range, let selection = page.selection(for: range) {
            // Leave some room above the match rather than pinning it to the top edge.
            var rect = selection.bounds(for: page)
            rect.origin.y += 120
            view.go(to: rect, on: page)
        } else {
            view.go(to: page)
        }
    }
}
/// Any other file, as Quick Look shows it: images, video, audio, fonts, and files without text.
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
