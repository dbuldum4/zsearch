#if os(macOS)
import AppKit
import SwiftUI
import ZSearchKit

/// Several results picked at once, and what can be done to all of them. The picking itself is
/// `ResultSelection`; `SearchModel.picks` holds it.
extension SearchModel {
    /// Asked before opening more files than this at once.
    static let openWithoutAsking = 10

    /// The picked results, in list order.
    var selectedHits: [SearchHit] { hits(for: picks.ids) }

    func hits(for ids: Set<SearchHit.ID>) -> [SearchHit] {
        hits.filter { ids.contains($0.id) }
    }

    /// The list picked these itself: a click, ⌘-click, ⇧-click, or ⌘A and ⇧↑/⇧↓ while it has the keyboard.
    func listPicked(_ ids: Set<SearchHit.ID>) {
        var next = picks
        let order = hits.map(\.id)
        if menuSelectsAll, ids == Set(order) { next.selectAll(in: order) } else { next.adopt(ids, in: order) }
        pick(next)
    }

    /// ⇧↓ (1) and ⇧↑ (-1) in the search field.
    func extendSelection(by delta: Int) {
        var next = picks
        next.extend(by: delta, in: hits.map(\.id))
        pick(next)
    }

    func selectAllResults() {
        var next = picks
        next.selectAll(in: hits.map(\.id))
        pick(next)
    }

    /// Back to the one result shown (Esc). False when only one was picked.
    func collapseSelection() -> Bool {
        guard picks.count > 1 else { return false }
        var next = picks
        next.collapse()
        pick(next)
        return true
    }

    func open(_ hits: [SearchHit]) {
        guard confirmOpening(hits.count) else { return }
        hits.forEach(open)
    }

    func openInEditor(_ hits: [SearchHit]) {
        guard confirmOpening(hits.count) else { return }
        hits.forEach(openInEditor)
    }

    func reveal(_ hits: [SearchHit]) {
        guard !hits.isEmpty else { return }
        QuickPanel.shared.fileOpened()
        NSWorkspace.shared.activateFileViewerSelecting(hits.map { URL(fileURLWithPath: $0.path) })
    }

    private func confirmOpening(_ count: Int) -> Bool {
        guard count > Self.openWithoutAsking else { return true }
        let alert = NSAlert()
        alert.messageText = "Open \(count) items?"
        alert.informativeText = "Each one opens in its own app or window."
        alert.addButton(withTitle: "Open")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

/// "3 selected" under the results, with what can be done to all of them.
struct SelectionBar: View {
    @Environment(SearchModel.self) private var model

    var body: some View {
        if model.pickedCount > 1 {
            Divider()
            HStack(spacing: 12) {
                Text("\(model.pickedCount) selected")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Spacer(minLength: 0)
                Group {
                    Button("Open", systemImage: "arrow.up.forward.app") { model.openSelected() }
                        .help("Open them all (Return)")
                    Button("Quick Look", systemImage: "eye") { model.toggleQuickLook() }
                        .help("Quick Look through them (Space)")
                    Button("Show in Finder", systemImage: "folder") { model.revealSelected() }
                        .help("Show them in Finder (⇧⌘R)")
                    Button("Copy Paths", systemImage: "doc.on.doc") { model.copySelectedPath() }
                        .help("Copy their paths, and the files for Finder and Mail (⇧⌘C)")
                    Button("Deselect", systemImage: "xmark.circle") { _ = model.collapseSelection() }
                        .help("Keep only the result shown (Esc)")
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
            }
            .font(.caption)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
        }
    }
}

/// The result menu for several results at once.
struct BatchMenu: View {
    let model: SearchModel
    let hits: [SearchHit]

    var body: some View {
        Button("Open \(hits.count) Items") { model.open(hits) }
        if hits.contains(where: { EditorApp.edits(kind: $0.kind, isDir: $0.isDir) }) {
            Button("Open in Editor") { model.openInEditor(hits) }
        }
        Button("Quick Look") { model.quickLook(hits) }
        Button("Show in Finder") { model.reveal(hits) }
        Button("Copy \(hits.count) Paths") { model.copyPaths(hits) }
        Divider()
        Button("Copy All Paths") { model.copyAllPaths() }
        Button("Fold Preview Around Matches") { model.toggleFoldedPreview() }
    }
}
#endif
