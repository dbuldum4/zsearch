#if os(macOS)
import SwiftUI
import ZSearchKit

/// A reflowed excerpt of the indexed book text. Uses the engine's lines and UTF-16 match
/// ranges, so reading mode follows the same matches and privacy rules as the text preview.
struct EbookPreviewView: View {
    let preview: FilePreview

    static func handles(_ p: FilePreview) -> Bool {
        !p.isDir && p.contentAllowed != false && p.message == nil
            && ["epub", "mobi"].contains(URL(fileURLWithPath: p.path).pathExtension.lowercased())
    }

    var body: some View {
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if let first = preview.lines.first, first.n > 1 {
                        excerptNote("Earlier text omitted")
                    }
                    ForEach(preview.lines, id: \.n) { line in
                        Text(attributed(highlightRuns(line.text, ranges: line.ranges), trimLeading: false))
                            .font(.system(size: 16, design: .serif))
                            .lineSpacing(5)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(line.n)
                    }
                    if let last = preview.lines.last, last.n < preview.totalLines {
                        excerptNote("More text after this excerpt")
                    }
                }
                .frame(maxWidth: 720, alignment: .leading)
                .padding(24)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: preview, initial: true) { previous, current in
                // A refresh preserves the reader's place, just as the document previews do.
                if previous != current, previous.id == current.id, previous.focusLine == current.focusLine { return }
                reader.scrollTo(current.focusLine, anchor: .top)
            }
        }
    }

    private func excerptNote(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary)
    }
}
#endif
