#if os(macOS)
import AppKit
import SwiftUI
import ZSearchKit

/// Word documents as AppKit reads them (headings, fonts, lists and tables), kept for the few most
/// recent files like `PDFDocuments`. A file that changed on disk is read again.
@MainActor
final class WordDocuments {
    static let shared = WordDocuments()

    /// The Office Open XML word-processing formats AppKit's reader opens.
    static let extensions: Set<String> = ["docx", "docm", "dotx", "dotm"]
    /// The reader runs on the main thread and drops pictures, which make up most of a big file.
    private static let maxBytes = 32 << 20

    private struct Key: Hashable {
        var path: String
        var size: Int
        var mtime: Double
    }

    private var cache: [Key: NSAttributedString] = [:]
    private var order: [Key] = []
    /// Files the reader could not open, so the preview doesn't try again on every redraw.
    private var failed: Set<Key> = []
    private let limit = 4

    /// The document for a preview, or nil if it isn't a Word file or can't be read (gone, damaged,
    /// password-protected, too big, or with no text).
    func document(for p: FilePreview) -> NSAttributedString? {
        guard !p.isDir, p.contentAllowed != false, p.size <= Self.maxBytes,
              Self.extensions.contains((p.path as NSString).pathExtension.lowercased()) else { return nil }
        let key = Key(path: p.path, size: p.size, mtime: p.mtime)
        if let doc = cache[key] {
            order.removeAll { $0 == key }
            order.append(key)
            return doc
        }
        guard !failed.contains(key) else { return nil }
        let url = URL(fileURLWithPath: p.path)
        guard let doc = try? NSAttributedString(url: url, options: [.documentType: NSAttributedString.DocumentType.officeOpenXML], documentAttributes: nil),
              doc.length > 0 else {
            if failed.count > 64 { failed.removeAll() }
            failed.insert(key)
            return nil
        }
        cache[key] = doc
        order.append(key)
        while order.count > limit { cache[order.removeFirst()] = nil }
        return doc
    }
}

/// A Word document laid out on a white page, scrolled to the match with the matching words
/// highlighted.
struct DocumentPreviewView: NSViewRepresentable {
    let preview: FilePreview
    let document: NSAttributedString

    final class Coordinator {
        var shown: FilePreview?
        var document: NSAttributedString?
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
        if !sameFile {
            storage.setAttributedString(document)
            coordinator.document = document
        }

        let text = storage.string
        let highlights = PageMap.occurrences(of: PageMap.matchedTerms(preview), in: text)
        // Temporary attributes leave the cached document as it was read.
        layout.removeTemporaryAttribute(.backgroundColor, forCharacterRange: NSRange(location: 0, length: storage.length))
        let color = NSColor.systemYellow.withAlphaComponent(0.5)
        for range in highlights { layout.addTemporaryAttribute(.backgroundColor, value: color, forCharacterRange: range) }

        // A refresh of the same file keeps the reader's place; anything else goes to the match.
        if sameFile, previous?.id == preview.id, previous?.focusLine == preview.focusLine { return }
        let focus = PageMap.locate(focusOf: preview, in: text) ?? highlights.first
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
        layout.ensureLayout(for: container)
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
