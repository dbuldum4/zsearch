#if os(macOS)
import AppKit
import SwiftUI
import ZSearchKit

/// Word documents as AppKit reads them (headings, fonts, lists and tables), kept for the few most
/// recent files like `PDFDocuments`. A file that changed on disk is read again. `load` reads them
/// off the main thread, with their text prepared for finding matches; the view only lays them out.
@MainActor
final class WordDocuments {
    static let shared = WordDocuments()

    /// The Office Open XML word-processing formats AppKit's reader opens and the engine indexes.
    static let extensions: Set<String> = ["docx", "docm", "dotx"]
    /// The reader drops pictures, which make up most of a big file; this caps what it goes through.
    private static let maxBytes = 32 << 20

    private struct Key: Hashable {
        var path: String
        var size: Int
        var mtime: Double

        init(_ p: FilePreview) {
            path = p.path
            size = p.size
            mtime = p.mtime
        }
    }

    /// A document read, its text prepared for `PageMap.locate`, and every match of recent terms.
    struct Entry: @unchecked Sendable {
        let document: NSAttributedString
        let prepared: PageMap.PreparedText
        var matches: [[String]: [NSRange]] = [:]
    }

    private var cache: [Key: Entry] = [:]
    private var order: [Key] = []
    /// Files the reader could not open, and when. The preview doesn't try again on every redraw,
    /// but does once `retryAfter` has passed, as the file may have been read halfway through a save.
    private var failed: [Key: Date] = [:]
    private static let retryAfter: TimeInterval = 30
    private var reading: [Key: Task<Entry?, Never>] = [:]
    private let limit = 4

    /// Whether a preview is of a Word file this reader would try, without reading it.
    static func handles(_ p: FilePreview) -> Bool {
        !p.isDir && p.contentAllowed != false && p.size <= maxBytes
            && extensions.contains((p.path as NSString).pathExtension.lowercased())
    }

    /// The document for a preview, if `load` read it.
    func document(for p: FilePreview) -> NSAttributedString? {
        guard Self.handles(p) else { return nil }
        let key = Key(p)
        guard let entry = cache[key] else { return nil }
        if order.last != key {
            order.removeAll { $0 == key }
            order.append(key)
        }
        return entry.document
    }

    /// The document's text prepared for `PageMap.locate`, and the matches of the preview's terms
    /// if `load` found them.
    func found(for p: FilePreview, terms: [String]) -> (prepared: PageMap.PreparedText, matches: [NSRange]?)? {
        guard let entry = cache[Key(p)] else { return nil }
        return (entry.prepared, entry.matches[terms])
    }

    func state(of p: FilePreview) -> DocumentState {
        let key = Key(p)
        if let entry = cache[key] { return entry.matches[PageMap.matchedTerms(p)] == nil ? .unknown : .ready }
        if let at = failed[key], Date().timeIntervalSince(at) < Self.retryAfter { return .failed }
        return .unknown
    }

    /// Read the preview's document and find its matches, off the main thread. A file that can't
    /// be read (gone, damaged, password-protected, or with no text) is marked failed.
    func load(_ p: FilePreview) async {
        guard Self.handles(p) else { return }
        let key = Key(p)
        let terms = PageMap.matchedTerms(p)
        if cache[key] == nil {
            let task = reading[key] ?? Task.detached(priority: .userInitiated) { () -> Entry? in
                let url = URL(fileURLWithPath: key.path)
                guard let doc = try? NSAttributedString(url: url, options: [.documentType: NSAttributedString.DocumentType.officeOpenXML], documentAttributes: nil),
                      doc.length > 0 else { return nil }
                let text = doc.string
                return Entry(document: doc, prepared: PageMap.PreparedText(text), matches: [terms: PageMap.occurrences(of: terms, in: text)])
            }
            reading[key] = task
            let entry = await task.value
            reading[key] = nil
            guard let entry else {
                if failed.count > 64 { failed.removeAll() }
                failed[key] = Date()
                return
            }
            failed[key] = nil
            if cache.updateValue(entry, forKey: key) == nil { order.append(key) }
            while order.count > limit { cache[order.removeFirst()] = nil }
        }
        guard let entry = cache[key], entry.matches[terms] == nil else { return }
        let text = entry.document.string
        let matches = await Task.detached(priority: .userInitiated) { PageMap.occurrences(of: terms, in: text) }.value
        guard cache[key] != nil else { return }
        // A few queries' worth: each new query adds its own.
        if cache[key]!.matches.count >= 4 { cache[key]!.matches.removeAll() }
        cache[key]!.matches[terms] = matches
    }
}
/// A Word document laid out on a white page, scrolled to the match with the matching words
/// highlighted.
struct DocumentPreviewView: NSViewRepresentable {
    let preview: FilePreview
    let document: NSAttributedString

    /// At most this many matches are highlighted at once: the ones nearest the focus.
    static let highlightLimit = 2000

    final class Coordinator {
        var shown: FilePreview?
        var document: NSAttributedString?
        /// Kept while the same document shows, so moving between its matches doesn't go through
        /// the whole document again: its text prepared for `PageMap.locate`, and every match.
        var prepared: PageMap.PreparedText?
        var terms: [String] = []
        var matches: [NSRange] = []
        var highlighted: [NSRange] = []
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView { Self.makeScrollView() }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        Self.show(preview, document: document, in: scroll, coordinator: context.coordinator)
    }

    static func makeScrollView() -> NSScrollView {
        // TextKit 1, because AppKit lays out the tables the reader makes (NSTextTable) only there.
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        layout.addTextContainer(container)

        let textView = NSTextView(frame: .zero, textContainer: container)
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.drawsBackground = true
        textView.backgroundColor = .white
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.autoresizingMask = [.width]
        textView.textContainerInset = NSSize(width: 24, height: 20)

        let scroll = NSScrollView()
        // Word's colors are chosen for white paper, so the page stays light in Dark Mode too.
        scroll.appearance = NSAppearance(named: .aqua)
        scroll.drawsBackground = true
        scroll.backgroundColor = .white
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = textView
        return scroll
    }

    static func show(_ preview: FilePreview, document: NSAttributedString, in scroll: NSScrollView, coordinator: Coordinator) {
        guard let textView = scroll.documentView as? NSTextView,
              let storage = textView.textStorage, let layout = textView.layoutManager else { return }
        let previous = coordinator.shown
        let sameFile = coordinator.document === document
        guard previous != preview || !sameFile else { return }
        coordinator.shown = preview
        let terms = PageMap.matchedTerms(preview)
        let found = WordDocuments.shared.found(for: preview, terms: terms)
        if !sameFile {
            storage.setAttributedString(document)
            coordinator.document = document
            coordinator.prepared = found?.prepared ?? PageMap.PreparedText(storage.string)
        }
        if !sameFile || terms != coordinator.terms {
            coordinator.terms = terms
            coordinator.matches = found?.matches ?? PageMap.occurrences(of: terms, in: storage.string)
        }

        let expected = PageMap.expectedLocation(ofFocusOf: preview, length: storage.length)
        let focus = coordinator.prepared.flatMap { PageMap.locate(focusOf: preview, in: $0, near: expected) }
            ?? PageMap.nearest(coordinator.matches, to: expected)
        let highlights = PageMap.window(coordinator.matches, around: focus?.location ?? expected, count: Self.highlightLimit)
        if !sameFile || highlights != coordinator.highlighted {
            coordinator.highlighted = highlights
            // Temporary attributes leave the cached document as it was read.
            layout.removeTemporaryAttribute(.backgroundColor, forCharacterRange: NSRange(location: 0, length: storage.length))
            let color = NSColor.systemYellow.withAlphaComponent(0.5)
            for range in highlights { layout.addTemporaryAttribute(.backgroundColor, value: color, forCharacterRange: range) }
        }

        // A refresh of the same file keeps the reader's place; anything else goes to the match.
        if sameFile, previous?.id == preview.id, previous?.focusLine == preview.focusLine { return }
        Self.reveal(focus, in: textView, scroll: scroll)
        // Layout may not be final on the first pass (a newly shown pane has no size yet).
        DispatchQueue.main.async { Self.reveal(focus, in: textView, scroll: scroll) }
    }

    /// Scroll so the focused match sits a little below the top, or to the top without one.
    static func reveal(_ range: NSRange?, in textView: NSTextView, scroll: NSScrollView) {
        let clip = scroll.contentView
        guard let range, let layout = textView.layoutManager, let container = textView.textContainer else {
            clip.scroll(to: .zero)
            scroll.reflectScrolledClipView(clip)
            return
        }
        // Only the text up to a screen or so past the match: the rest is laid out in the background.
        let length = textView.textStorage?.length ?? 0
        layout.ensureLayout(forCharacterRange: NSRange(location: 0, length: min(length, NSMaxRange(range) + 4000)))
        let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let rect = layout.boundingRect(forGlyphRange: glyphs, in: container)
        let visible = clip.bounds.height
        let maxY = max(0, textView.frame.height - visible)
        let y = min(max(0, rect.minY + textView.textContainerOrigin.y - min(120, visible / 3)), maxY)
        clip.scroll(to: NSPoint(x: 0, y: y))
        scroll.reflectScrolledClipView(clip)
    }
}
#endif
