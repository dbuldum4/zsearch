#if os(macOS)
import AppKit
import PDFKit
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
        let highlights = Self.highlights(for: preview, in: document)
        view.highlightedSelections = highlights.isEmpty ? nil : highlights
        // A refresh of the same file keeps the reader's place; anything else goes to the match.
        if sameFile, previous?.id == preview.id, previous?.focusLine == preview.focusLine { return }
        Self.reveal(preview, highlights: highlights, in: view)
        // Layout may not be final on the first pass (a newly shown pane has no size yet).
        DispatchQueue.main.async { Self.reveal(preview, highlights: highlights, in: view) }
    }

    /// The 0-based page the preview is focused on, as far as the document has pages.
    static func focusPage(of p: FilePreview, in document: PDFDocument) -> Int {
        min(PageMap.page(ofLine: p.focusLine, pageStarts: p.pageStarts), document.pageCount - 1)
    }

    /// The matched words on the pages that have matches (the focus page first). Only those pages
    /// are searched, so a long document doesn't stall the switch to it.
    static func highlights(for p: FilePreview, in document: PDFDocument) -> [PDFSelection] {
        let terms = PageMap.matchedTerms(p)
        guard !terms.isEmpty else { return [] }
        let focus = focusPage(of: p, in: document)
        var pages = [focus]
        for page in PageMap.pages(ofLines: p.matchLines, pageStarts: p.pageStarts).prefix(200)
        where page != focus && page < document.pageCount {
            pages.append(page)
        }

        let color = NSColor.systemYellow.withAlphaComponent(0.5)
        var out: [PDFSelection] = []
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
                    out.append(selection)
                }
            }
        }
        return out
    }

    /// Scroll to the first highlight on the focus page, or to the top of that page if it has none.
    static func reveal(_ p: FilePreview, highlights: [PDFSelection], in view: PDFView) {
        guard let document = view.document, document.pageCount > 0,
              let page = document.page(at: focusPage(of: p, in: document)) else { return }
        if let first = highlights.first(where: { $0.pages.contains(page) }) {
            // Leave some room above the match rather than pinning it to the top edge.
            var rect = first.bounds(for: page)
            rect.origin.y += 120
            view.go(to: rect, on: page)
        } else {
            view.go(to: page)
        }
    }
}
#endif
