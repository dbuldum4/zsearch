#if os(macOS)
import AppKit
import SwiftUI
import ZSearchKit

/// "3 identical copies" under a result the engine folded byte-identical files into, opening to
/// where each copy is, with its actions.
struct DuplicateCopies: View {
    @Environment(SearchModel.self) private var model
    let hit: SearchHit
    let copies: [FileCopy]
    @State private var expanded = false
    @State private var comparing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 10) {
                Button {
                    expanded.toggle()
                } label: {
                    Label(hit.copiesMore == true ? "At least \(hit.copyCount) identical copies" : "\(hit.copyCount) identical copies", systemImage: expanded ? "chevron.down" : "chevron.right")
                }
                .buttonStyle(.borderless)
                .help("Files with exactly the same contents (same size and SHA-256), in other places")
                if expanded {
                    Button("Compare") { comparing = true }
                        .buttonStyle(.link)
                        .popover(isPresented: $comparing, arrowEdge: .bottom) { CopiesComparison(hit: hit, copies: copies) }
                    Button("Show All in Finder") { model.reveal(paths: [hit.path] + copies.map(\.path)) }
                        .buttonStyle(.link)
                }
            }
            if expanded {
                ForEach(copies) { copy in
                    HStack(spacing: 6) {
                        Text(copy.name == hit.name ? copy.folder : copy.display)
                            .lineLimit(1)
                            .truncationMode(.head)
                        Text(copy.modified.formatted(date: .abbreviated, time: .shortened))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Button { model.open(path: copy.path) } label: { Image(systemName: "arrow.up.forward.app") }
                            .help("Open")
                        Button { model.reveal(paths: [copy.path]) } label: { Image(systemName: "folder") }
                            .help("Show in Finder")
                        Button { model.copyPath(copy.path) } label: { Image(systemName: "doc.on.doc") }
                            .help("Copy Path")
                    }
                    .buttonStyle(.borderless)
                    .onDrag { NSItemProvider(object: URL(fileURLWithPath: copy.path) as NSURL) }
                }
                .padding(.leading, 16)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.leading, 22)
    }
}

/// The copies side by side: the bytes are the same, so where they are and their dates are what differs.
private struct CopiesComparison: View {
    let hit: SearchHit
    let copies: [FileCopy]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(hit.copyCount) copies, \(ByteCountFormatter.string(fromByteCount: Int64(hit.size), countStyle: .file)) each, byte-for-byte identical")
                .font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
                GridRow {
                    Text("Name")
                    Text("Folder")
                    Text("Modified")
                }
                .foregroundStyle(.secondary)
                Divider()
                row(name: hit.name, folder: hit.folder, modified: hit.modified)
                ForEach(copies) { row(name: $0.name, folder: $0.folder, modified: $0.modified) }
            }
            .textSelection(.enabled)
        }
        .font(.callout)
        .padding(14)
        .frame(minWidth: 420)
    }

    private func row(name: String, folder: String, modified: Date) -> some View {
        GridRow {
            Text(name).lineLimit(1)
            Text(folder.isEmpty ? "/" : folder).lineLimit(1).truncationMode(.head)
            Text(modified.formatted(date: .abbreviated, time: .shortened)).monospacedDigit()
        }
    }
}
#endif
