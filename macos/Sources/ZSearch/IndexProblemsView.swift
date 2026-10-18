#if os(macOS)
import AppKit
import SwiftUI
import ZSearchKit

/// Window › Indexing Problems: the files whose contents search cannot find, or finds only in
/// part, with why in plain words, and what can be done (read them again, or a setting to change).
struct IndexProblemsView: View {
    @Environment(SearchModel.self) private var model
    /// The sidebar's choice: a category, or `Self.all`.
    @State private var category = Self.all
    @State private var search = ""
    @State private var list: ProblemList?
    @State private var problems: [IndexProblem] = []
    @State private var selection = Set<IndexProblem.ID>()
    @State private var explanation: Explanation?
    @State private var message: String?
    @State private var loading = false

    private static let all = "all"
    private static let page = 200

    /// What the list shows; a new one loads it again.
    private struct Key: Equatable {
        var category: String
        var search: String
        /// Changes when an index run starts or ends.
        var indexing: Bool
        var lastIndexedAt: Double?
    }

    private var key: Key {
        Key(category: category, search: search.trimmingCharacters(in: .whitespaces), indexing: model.indexing, lastIndexedAt: model.stats?.lastIndexedAt)
    }

    private var categories: [ProblemCount] { list?.categories ?? [] }
    private var counted: ProblemCount? { categories.first { $0.category == category } }
    private var selected: [IndexProblem] { problems.filter { selection.contains($0.id) } }

    var body: some View {
        NavigationSplitView {
            List(selection: $category) {
                Label {
                    HStack {
                        Text("All Problems")
                        Spacer()
                        Text(categories.reduce(0) { $0 + $1.count }.formatted()).foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                }
                .tag(Self.all)
                Section("Categories") {
                    ForEach(categories) { c in
                        Label {
                            HStack {
                                Text(c.label)
                                Spacer()
                                Text(c.count.formatted()).foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: Self.symbol(c.category))
                        }
                        .tag(c.category)
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 240)
        } detail: {
            VStack(spacing: 0) {
                if let explanation {
                    ProblemDetails(details: Details(explanation), retry: { retry(paths: [explanation.path]) }, close: { self.explanation = nil })
                        .padding([.horizontal, .top])
                }
                table
                if selected.count == 1, let p = selected.first, explanation == nil {
                    Divider()
                    ProblemDetails(details: Details(p), retry: { retry(paths: [p.path]) }, close: nil)
                        .padding()
                }
                Divider()
                footer
            }
            .searchable(text: $search, placement: .toolbar, prompt: "Filter by name or folder")
            .toolbar {
                ToolbarItem {
                    Button {
                        chooseFileToExplain()
                    } label: {
                        Label("Why Isn't a File Searchable?", systemImage: "questionmark.circle")
                    }
                    .help("Choose a file to see whether its contents are searchable, and why not.")
                }
            }
        }
        .navigationTitle("Indexing Problems")
        .task(id: key) {
            // Typing in the search field: wait for a pause.
            if !key.search.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            await load()
        }
        .task(id: model.explaining) {
            guard let path = model.explaining else { return }
            await explain(path)
            model.explaining = nil
        }
    }

    private var table: some View {
        Table(problems, selection: $selection) {
            TableColumn("Name") { p in
                VStack(alignment: .leading, spacing: 1) {
                    Text(p.name).lineLimit(1)
                    Text(Self.folder(of: p.path)).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                .help(p.path)
            }
            .width(min: 160, ideal: 240)
            TableColumn("Why") { p in
                Text(p.reason).lineLimit(2).help(p.detail.map { "\(p.reason)\n\($0)" } ?? p.reason)
            }
            .width(min: 200, ideal: 360)
            TableColumn("Size") { p in
                Text(ByteCountFormatter.string(fromByteCount: Int64(p.size), countStyle: .file)).foregroundStyle(.secondary)
            }
            .width(min: 60, ideal: 70)
            TableColumn("Modified") { p in
                Text(p.modified.formatted(date: .abbreviated, time: .omitted)).foregroundStyle(.secondary)
            }
            .width(min: 80, ideal: 100)
        }
        .contextMenu(forSelectionType: IndexProblem.ID.self) { ids in
            let chosen = problems.filter { ids.contains($0.id) }
            Button("Show in Finder") { reveal(chosen.map(\.path)) }
            if chosen.contains(where: \.retry) {
                Button("Read Again") { retry(paths: chosen.filter(\.retry).map(\.path)) }
            }
            Button(chosen.count == 1 ? "Copy Path" : "Copy Paths") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(chosen.map(\.path).joined(separator: "\n"), forType: .string)
            }
        } primaryAction: { ids in
            reveal(problems.filter { ids.contains($0.id) }.map(\.path))
        }
        .overlay {
            if !loading, problems.isEmpty {
                if list == nil, let message {
                    ContentUnavailableView("Indexing problems are not available", systemImage: "exclamationmark.triangle", description: Text(message))
                } else if key.search.isEmpty {
                    ContentUnavailableView("No problems", systemImage: "checkmark.circle", description: Text(category == Self.all ? "zsearch read the contents of every file it can." : "No files are in this category."))
                } else {
                    ContentUnavailableView.search(text: key.search)
                }
            }
        }
    }

    private var footer: some View {
        HStack {
            if let list {
                Text(problems.count < list.total ? "\(problems.count.formatted()) of \(list.total.formatted()) files" : "\(list.total.formatted()) files")
                    .foregroundStyle(.secondary)
                if problems.count < list.total {
                    Button("Show More") { Task { await load(more: true) } }
                        .disabled(loading)
                }
            }
            if let message, list != nil {
                Text(message).foregroundStyle(.secondary).lineLimit(2).help(message)
            }
            Spacer()
            if !selected.isEmpty {
                Button("Show in Finder") { reveal(selected.map(\.path)) }
                Button("Read Selected Again") { retry(paths: selected.filter(\.retry).map(\.path)) }
                    .disabled(!selected.contains(where: \.retry))
                    .help("Read these files again with the next index update, which starts now.")
            } else if let c = counted, c.retry {
                Button("Read All Again") { retryCategory(c.category) }
                    .help("Read every file in \(c.label.lowercased()) again, with an index update that starts now.")
            }
        }
        .controlSize(.small)
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    // MARK: - Requests

    private func load(more: Bool = false) async {
        loading = true
        defer { loading = false }
        let request = Request.problems(categories: category == Self.all ? [] : [category], query: key.search, offset: more ? problems.count : 0, limit: Self.page)
        do {
            guard case let .problems(reply)? = try await model.problemsRequest(request) else {
                if list == nil { message = "The zsearch engine is not running." }
                return
            }
            list = reply
            problems = more ? problems + reply.problems : reply.problems
            let ids = Set(problems.map(\.id))
            selection = selection.filter { ids.contains($0) }
            // A category emptied by a retry or an update: back to all of them.
            if category != Self.all, !reply.categories.contains(where: { $0.category == category }), key.search.isEmpty { category = Self.all }
        } catch {
            message = error.localizedDescription
        }
    }

    private func explain(_ path: String) async {
        do {
            guard case let .explanation(e)? = try await model.problemsRequest(.explain(path: path)) else { return }
            explanation = e
        } catch {
            message = error.localizedDescription
        }
    }

    private func retry(paths: [String]) {
        guard !paths.isEmpty else { return }
        send(.retryProblems(paths: paths))
    }

    private func retryCategory(_ category: String) {
        send(.retryCategory(category))
    }

    private func send(_ request: Request) {
        Task {
            do {
                guard case let .retried(r)? = try await model.problemsRequest(request) else { return }
                var text = r.retried == 0 ? "Nothing to read again." : "\(r.retried.formatted()) \(r.retried == 1 ? "file is" : "files are") read again: the index is updating."
                if let first = r.refused.first { text += " \((first.path as NSString).lastPathComponent): \(first.reason)" }
                message = text
                if let e = explanation, r.retried > 0 { await explain(e.path) }
                await load()
            } catch {
                message = error.localizedDescription
            }
        }
    }

    private func chooseFileToExplain() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Choose a file to see whether its contents are searchable."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await explain(url.path) }
    }

    private func reveal(_ paths: [String]) {
        guard !paths.isEmpty else { return }
        NSWorkspace.shared.activateFileViewerSelecting(paths.map { URL(fileURLWithPath: $0) })
    }

    static func folder(of path: String) -> String {
        let dir = (path as NSString).deletingLastPathComponent
        let home = NSHomeDirectory()
        return dir == home ? "~" : dir.hasPrefix(home + "/") ? "~" + dir.dropFirst(home.count) : dir
    }

    static func symbol(_ category: String) -> String {
        switch category {
        case "unreadable": "exclamationmark.triangle"
        case "timeout": "clock.badge.exclamationmark"
        case "transcription": "waveform.badge.exclamationmark"
        case "too-large": "arrow.up.left.and.arrow.down.right"
        case "no-text": "text.badge.xmark"
        case "truncated": "scissors"
        case "dataset": "photo.stack"
        case "secret": "key"
        case "names-only": "textformat"
        case "cloud": "icloud"
        default: "questionmark.circle"
        }
    }
}

/// What the details box shows, of a listed problem or of an explanation.
private struct Details {
    var path: String
    var searchable: String
    var category: String?
    var reason: String
    var detail: String?
    var setting: String?
    var retry: Bool
    var at: Double?

    init(_ e: Explanation) {
        self.init(path: e.path, searchable: e.searchable, category: e.category, reason: e.reason, detail: e.detail, setting: e.setting, retry: e.retry, at: e.at)
    }

    init(_ p: IndexProblem) {
        self.init(path: p.path, searchable: p.category == "truncated" ? "content" : "name", category: p.category, reason: p.reason, detail: p.detail, setting: p.setting, retry: p.retry, at: p.at)
    }

    init(path: String, searchable: String, category: String?, reason: String, detail: String?, setting: String?, retry: Bool, at: Double?) {
        self.path = path
        self.searchable = searchable
        self.category = category
        self.reason = reason
        self.detail = detail
        self.setting = setting
        self.retry = retry
        self.at = at
    }

    var headline: String {
        switch searchable {
        case "content": category == "truncated" ? "Only part of its text is searchable" : "Its name and text are searchable"
        case "name": "Only its name is searchable"
        default: "It is not in the index"
        }
    }

    var symbol: (name: String, color: Color) {
        switch searchable {
        case "content": category == nil ? ("checkmark.circle.fill", .green) : ("exclamationmark.circle.fill", .orange)
        case "name": ("exclamationmark.triangle.fill", .orange)
        default: ("xmark.circle.fill", .secondary)
        }
    }
}

private struct ProblemDetails: View {
    let details: Details
    let retry: () -> Void
    /// Nil for the details of the selected row, which go with the selection.
    let close: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: details.symbol.name).foregroundStyle(details.symbol.color)
                VStack(alignment: .leading, spacing: 2) {
                    Text((details.path as NSString).lastPathComponent).font(.headline)
                    Text(details.headline).foregroundStyle(.secondary)
                }
                Spacer()
                if let close {
                    Button(action: close) { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                        .help("Close")
                }
            }
            Text(details.reason).fixedSize(horizontal: false, vertical: true)
            if let detail = details.detail {
                Text("Error: \(detail)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            HStack(spacing: 12) {
                Text(IndexProblemsView.folder(of: details.path) + "/" + (details.path as NSString).lastPathComponent)
                    .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                if let at = details.at {
                    Text("Read \(Date(timeIntervalSince1970: at / 1000).formatted(.relative(presentation: .named)))")
                }
                if let setting = details.setting {
                    Text("Setting: \(setting)")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            HStack {
                Button("Show in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: details.path)])
                }
                if details.retry {
                    Button("Read Again", action: retry)
                        .help("Read it again with an index update that starts now.")
                }
                if details.setting != nil {
                    SettingsLink { Text("Open Settings…") }
                }
            }
            .controlSize(.small)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Opens the Indexing Problems window (a menu command, and a button in Settings).
struct IndexProblemsButton: View {
    @Environment(\.openWindow) private var openWindow
    var title = "Indexing Problems…"

    var body: some View {
        Button(title) { openWindow(id: "problems") }
    }
}
#endif
