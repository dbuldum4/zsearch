#if os(macOS)
import AppKit
import SwiftUI
import ZSearchKit

/// Two panes side by side with a draggable divider. Unlike `HSplitView`, the divider only moves
/// when you drag it, never because the content of a pane changed. The position is remembered.
struct SplitPanes<Left: View, Right: View>: View {
    @AppStorage("resultsPaneFraction") private var fraction = 0.42
    @State private var dragStartFraction: Double?
    private let left: Left
    private let right: Right
    private let minWidth: CGFloat = 260

    init(@ViewBuilder left: () -> Left, @ViewBuilder right: () -> Right) {
        self.left = left()
        self.right = right()
    }

    var body: some View {
        GeometryReader { geo in
            let total = geo.size.width
            let leftWidth = width(for: fraction, total: total)
            HStack(spacing: 0) {
                left
                    .frame(width: leftWidth)
                Divider()
                right
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(width: total, height: geo.size.height)
            .overlay(alignment: .topLeading) {
                Color.clear
                    .frame(width: 9)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .offset(x: leftWidth - 4)
                    .onHover { inside in
                        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                    }
                    .gesture(
                        DragGesture(minimumDistance: 1, coordinateSpace: .global)
                            .onChanged { value in
                                guard total > 0 else { return }
                                let start = dragStartFraction ?? fraction
                                dragStartFraction = start
                                fraction = Double(width(for: start, total: total) + value.translation.width) / Double(total)
                            }
                            .onEnded { _ in
                                dragStartFraction = nil
                                fraction = Double(width(for: fraction, total: total)) / Double(max(total, 1))
                            }
                    )
            }
        }
    }

    private func width(for fraction: Double, total: CGFloat) -> CGFloat {
        guard total > 2 * minWidth else { return max(0, total / 2) }
        return min(max(CGFloat(fraction) * total, minWidth), total - minWidth)
    }
}

/// The preview text: one read-only, non-wrapping AppKit text view. Switching files replaces its
/// text in place (one attributed string) instead of rebuilding a SwiftUI row per line, and the
/// matching line is centered without an animated jump.
struct PreviewTextView: NSViewRepresentable {
    let preview: FilePreview

    final class Coordinator {
        var shown: FilePreview?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = false
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)

        let textView = NSTextView(frame: .zero, textContainer: container)
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.isRichText = true
        textView.isHorizontallyResizable = true
        textView.isVerticallyResizable = true
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.autoresizingMask = [.width, .height]
        textView.textContainerInset = NSSize(width: 10, height: 8)

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = textView
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let textView = scroll.documentView as? NSTextView else { return }
        let previous = context.coordinator.shown
        guard previous != preview else { return }
        context.coordinator.shown = preview

        let (text, focus) = Self.render(preview)
        textView.textStorage?.setAttributedString(text)
        textView.sizeToFit()
        // A refresh of the same file keeps the reader's scroll position; anything else centers the match.
        if previous?.id == preview.id, previous?.focusLine == preview.focusLine { return }
        Self.center(focus, in: textView, scroll: scroll)
        // Layout may not be final on the first pass (a newly shown pane has no size yet).
        DispatchQueue.main.async { Self.center(focus, in: textView, scroll: scroll) }
    }

    /// The preview as one attributed string with a line-number gutter, and the range of the focus line.
    static func render(_ p: FilePreview) -> (NSAttributedString, NSRange?) {
        let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        let gutterFont = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        let matchGutterFont = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        let body: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.labelColor]
        let gutter: [NSAttributedString.Key: Any] = [.font: gutterFont, .foregroundColor: NSColor.tertiaryLabelColor]
        let matchGutter: [NSAttributedString.Key: Any] = [.font: matchGutterFont, .foregroundColor: NSColor.controlAccentColor]
        let highlight: [NSAttributedString.Key: Any] = [.backgroundColor: NSColor.systemYellow.withAlphaComponent(0.35)]
        let digits = String(p.lines.last?.n ?? 1).count
        let matches = Set(p.matchLines)
        // Code is colored by its file type; plain text, PDFs and other documents stay plain.
        var syntax = p.isDir ? nil : SyntaxLanguage.forPath(p.path).map { SyntaxHighlighter(language: $0) }

        let out = NSMutableAttributedString()
        var focus: NSRange?
        for line in p.lines {
            let start = out.length
            let number = String(line.n)
            let pad = String(repeating: " ", count: max(0, digits - number.count))
            out.append(NSAttributedString(string: pad + number + "  ", attributes: matches.contains(line.n) ? matchGutter : gutter))
            let textStart = out.length
            out.append(NSAttributedString(string: line.text, attributes: body))
            // Syntax tokens and engine ranges are UTF-16 offsets, the same unit NSString uses.
            let length = (line.text as NSString).length
            for t in syntax?.tokens(line.text) ?? [] where t.start < t.end && t.end <= length {
                out.addAttribute(.foregroundColor, value: syntaxColor(t.kind), range: NSRange(location: textStart + t.start, length: t.end - t.start))
            }
            // Matches are a background, so highlighted code keeps its colors.
            for r in line.ranges where r.count == 2 {
                let a = max(0, r[0]), b = min(r[1], length)
                if a < b { out.addAttributes(highlight, range: NSRange(location: textStart + a, length: b - a)) }
            }
            out.append(NSAttributedString(string: "\n", attributes: body))
            if line.n == p.focusLine { focus = NSRange(location: start, length: out.length - start) }
        }
        return (out, focus)
    }

    static func syntaxColor(_ kind: SyntaxKind) -> NSColor {
        switch kind {
        case .keyword: return .systemPink
        case .type: return .systemPurple
        case .string: return .systemRed
        case .number: return .systemBlue
        case .comment: return .secondaryLabelColor
        case .meta: return .systemOrange
        }
    }

    static func center(_ range: NSRange?, in textView: NSTextView, scroll: NSScrollView) {
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
        let y = min(max(0, rect.midY + textView.textContainerOrigin.y - visible / 2), maxY)
        clip.scroll(to: NSPoint(x: 0, y: y))
        scroll.reflectScrolledClipView(clip)
    }
}
#endif
