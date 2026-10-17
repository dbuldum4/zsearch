#if os(macOS)
import AppKit
import QuickLook
import SwiftUI
import UniformTypeIdentifiers
import ZSearchKit

struct ContentView: View {
    @Environment(SearchModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @FocusState private var searchFocused: Bool
    /// In the floating panel (see `QuickPanel`) rather than the main window.
    let isPanel: Bool

    init(isPanel: Bool = false) {
        self.isPanel = isPanel
    }

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            SearchBar(focused: $searchFocused)
            FilterBar()
            Divider()
            if let failure = model.engineFailure {
                EngineFailureView(message: failure)
            } else {
                SplitPanes {
                    ResultsList()
                } right: {
                    PreviewPane()
                }
            }
            Divider()
            StatusBar()
        }
        .background { if isPanel { PanelShortcuts() } }
        // The setup sheet belongs to the main window.
        .sheet(isPresented: isPanel ? .constant(false) : $model.showSetup) {
            SetupView(inSheet: true)
                .environment(model)
                .interactiveDismissDisabled(model.firstRun)
        }
        .onAppear {
            searchFocused = true
            guard !isPanel else { return }
            let open = openWindow
            model.openMainWindow = { open(id: "main") }
        }
        .onChange(of: model.focusRequest) { searchFocused = true }
        // Quick Look is driven from the window it was opened in.
        .quickLookPreview(isPanel == model.quickLookInPanel ? $model.quickLookURL : .constant(nil))
    }
}

struct SearchBar: View {
    @Environment(SearchModel.self) private var model
    @Environment(\.dismissPanel) private var dismissPanel
    var focused: FocusState<Bool>.Binding

    var body: some View {
        @Bindable var model = model
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Search names and contents   ext:pdf  in:~/Documents  /regex/", text: $model.query)
                .textFieldStyle(.plain)
                .font(.title3)
                .focused(focused)
                .onSubmit { model.openSelected() }
                .onKeyPress(.downArrow) {
                    model.moveSelection(by: 1)
                    return .handled
                }
                .onKeyPress(.upArrow) {
                    model.moveSelection(by: -1)
                    return .handled
                }
                .onKeyPress(.escape) {
                    if model.query.isEmpty {
                        // In the panel, a second Esc puts it away.
                        guard let dismissPanel else { return .ignored }
                        dismissPanel()
                        return .handled
                    }
                    model.query = ""
                    return .handled
                }
            if !Edition.semanticOnly {
                Picker("Mode", selection: $model.mode) {
                    Text("Find").tag(Mode.find)
                    Text("Fuzzy").tag(Mode.fuzzy)
                    Text("Semantic").tag(Mode.semantic)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .help("Find: exact text in names and contents (/…/ for a regex). Fuzzy: forgiving name matching. Semantic: files about what you describe (turn it on in Settings › Semantic).")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
}

struct ResultsList: View {
    @Environment(SearchModel.self) private var model

    var body: some View {
        @Bindable var model = model
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
            HStack {
                ForEach(["name", "size", "date", "path"], id: \.self) { key in
                    Button(key.capitalized) { model.sortResults(key) }.buttonStyle(.plain)
                }
            }.font(.caption).padding(.horizontal)
            List(model.hits, selection: $model.selection) { hit in
                ResultRow(hit: hit).equatable()
            }
            .listStyle(.inset)
            .contextMenu(forSelectionType: SearchHit.ID.self) { ids in
                if let hit = model.hits.first(where: { ids.contains($0.id) }) {
                    Button("Open") { model.open(hit) }
                    if EditorApp.edits(kind: hit.kind, isDir: hit.isDir) {
                        Button("Open in Editor") { model.openInEditor(hit) }
                    }
                    Button("Quick Look") {
                        model.selection = hit.id
                        model.toggleQuickLook()
                    }
                    Button("Show in Finder") { model.reveal(hit) }
                    Button("Copy Path") { model.copyPath(hit) }
                    Button("Exclude from Index") { model.exclude(hit) }
                    Button("Copy All Paths") { model.copyAllPaths() }
                    Button("Fold Preview Around Matches") { model.toggleFoldedPreview() }
                }
            } primaryAction: { ids in
                if let hit = model.hits.first(where: { ids.contains($0.id) }) { model.open(hit) }
            }
            // In views of their own, so a new selection or a keystroke doesn't redo this list's body.
            .background { SelectionScroller(proxy: proxy) }
            .onKeyPress(.space) {
                model.toggleQuickLook()
                return .handled
            }
            .overlay { NoResultsNote() }
            }
        }
    }
}

/// Keeps the selected result in view.
private struct SelectionScroller: View {
    @Environment(SearchModel.self) private var model
    let proxy: ScrollViewProxy

    var body: some View {
        Color.clear
            .onChange(of: model.selection) { _, id in
                if let id { proxy.scrollTo(id) }
            }
    }
}

private struct NoResultsNote: View {
    @Environment(SearchModel.self) private var model

    var body: some View {
        // A query the engine could not run (`re:[`, say) comes back with its reason and no hits.
        if model.hits.isEmpty, let error = model.response?.error, !error.isEmpty {
            Text(error)
                .foregroundStyle(.orange)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
                .padding()
        } else if model.hits.isEmpty, model.response != nil {
            Text(model.query.isEmpty ? "No recent files" : "No results")
                .foregroundStyle(.secondary)
        }
    }
}

struct ResultRow: View, Equatable {
    let hit: SearchHit

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                FileIcon(hit: hit)
                Text(hit.name + (hit.isDir ? "/" : ""))
                    .fontWeight(.medium)
                    .lineLimit(1)
                Text(hit.folder)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            if let line = hit.lines.first {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(location(of: line, kind: hit.kind))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                    Text(attributed(highlightRuns(line.text, ranges: line.ranges), trimLeading: true))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .padding(.leading, 2)
            }
        }
        .padding(.vertical, 2)
        // Drag a result into Mail, Slack, Finder or any app that takes files.
        .onDrag { NSItemProvider(object: URL(fileURLWithPath: hit.path) as NSURL) }
    }
}

/// The file's icon as Finder shows it: by file type for files (no disk access), the folder's or
/// app's own icon for folders and apps.
struct FileIcon: View {
    let hit: SearchHit

    var body: some View {
        Image(nsImage: FileIcons.icon(path: hit.path, isDir: hit.isDir))
            .resizable()
            .interpolation(.high)
            .frame(width: 16, height: 16)
            .help(kindBadge(hit.kind))
    }
}

@MainActor
enum FileIcons {
    private static var byType: [String: NSImage] = [:]
    private static let byPath = NSCache<NSString, NSImage>()

    static func icon(path: String, isDir: Bool) -> NSImage {
        if isDir {
            if let cached = byPath.object(forKey: path as NSString) { return cached }
            let image = NSWorkspace.shared.icon(forFile: path)
            byPath.setObject(image, forKey: path as NSString)
            return image
        }
        let ext = (path as NSString).pathExtension.lowercased()
        if let cached = byType[ext] { return cached }
        let image = NSWorkspace.shared.icon(for: UTType(filenameExtension: ext) ?? .data)
        byType[ext] = image
        return image
    }
}

struct PreviewPane: View {
    @Environment(SearchModel.self) private var model
    /// PDFs show their pages unless the reader picked the extracted text instead, here or in Settings.
    @AppStorage(AppSettings.pdfShowsText) private var pdfShowsText = false
    /// Word documents show their formatting unless the reader picked the extracted text instead.
    @AppStorage(AppSettings.documentShowsText) private var documentShowsText = false
    @AppStorage(AppSettings.ebookShowsText) private var ebookShowsText = false
    /// Images show themselves unless the reader picked the text OCR read from them.
    @AppStorage(AppSettings.imageShowsText) private var imageShowsText = false

    /// Bumped when a document this pane waited on is ready (see `PreviewPreparation`).
    @State private var documentsLoaded = 0

    /// Kinds Quick Look shows better than any text could.
    static let visualKinds: Set<String> = ["image", "video", "audio", "font"]

    private struct Showing: Equatable {
        var preview: FilePreview
        var pdfShowsText: Bool
        var documentShowsText: Bool
    }

    var body: some View {
        // The last preview stays up while the next one loads (a few milliseconds), so switching
        // files swaps the content in place instead of flashing an empty pane. `SearchModel` shows a
        // preview once its document is open, so the documents here are only the ones already open.
        if let p = model.preview, !model.hits.isEmpty {
            let _ = documentsLoaded
            let pdf = p.kind == "pdf" && p.contentAllowed != false ? PDFDocuments.shared.document(for: p) : nil
            // A Word file is only read when the document will show.
            let wordFile = pdf == nil && WordDocuments.handles(p)
            let word = wordFile && (!documentShowsText || p.message != nil) ? WordDocuments.shared.document(for: p) : nil
            let ebook = EbookPreviewView.handles(p)
            // Images, video and audio, and other files without text: Quick Look shows them.
            let visual = p.contentAllowed != false && pdf == nil && word == nil && !p.isDir && (Self.visualKinds.contains(p.kind) || p.message != nil) && FileManager.default.fileExists(atPath: p.path)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(p.display)
                            .font(.headline)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(details(of: p))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if pdf != nil, p.message == nil {
                        Picker("Show", selection: $pdfShowsText) {
                            Text("Pages").tag(false)
                            Text("Text").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .controlSize(.small)
                        .fixedSize()
                        .help("Show the PDF's pages, or the text zsearch read from it")
                    } else if wordFile, p.message == nil, documentShowsText || word != nil {
                        Picker("Show", selection: $documentShowsText) {
                            Text("Document").tag(false)
                            Text("Text").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .controlSize(.small)
                        .fixedSize()
                        .help("Show the formatted document, or the text zsearch read from it")
                    } else if ebook {
                        Picker("Show", selection: $ebookShowsText) {
                            Text("Reading").tag(false)
                            Text("Text").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .controlSize(.small)
                        .fixedSize()
                        .help("Show a reflowed excerpt, or the line-numbered text zsearch read from the book")
                    } else if visual, p.message == nil {
                        Picker("Show", selection: $imageShowsText) {
                            Text(p.kind == "image" ? "Image" : "File").tag(false)
                            Text("Text").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .controlSize(.small)
                        .fixedSize()
                        .help("Show the file, or the text zsearch read from it")
                    }
                }
                .padding(10)
                Divider()
                // A PDF without indexed text (a scan, say) still shows its pages.
                if let pdf, !pdfShowsText || p.message != nil {
                    PDFPreviewView(preview: p, document: pdf)
                } else if let word {
                    DocumentPreviewView(preview: p, document: word)
                } else if ebook, !ebookShowsText {
                    EbookPreviewView(preview: p)
                } else if visual, !imageShowsText || p.message != nil {
                    QuickLookView(url: URL(fileURLWithPath: p.path))
                } else if let message = p.message {
                    Text(message)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    PreviewTextView(preview: p)
                }
            }
            .task(id: Showing(preview: p, pdfShowsText: pdfShowsText, documentShowsText: documentShowsText)) {
                guard PreviewPreparation.needsDocument(p) else { return }
                await PreviewPreparation.prepare(p)
                if !Task.isCancelled { documentsLoaded += 1 }
            }
        } else {
            Color.clear
        }
    }

    private func details(of p: FilePreview) -> String {
        var parts: [String] = []
        if !p.isDir { parts.append(ByteCountFormatter.string(fromByteCount: Int64(p.size), countStyle: .file)) }
        parts.append("modified " + Date(timeIntervalSince1970: p.mtime / 1000).formatted(date: .abbreviated, time: .shortened))
        if let at = p.matchLines.firstIndex(of: p.focusLine), p.matchLines.count > 1 {
            parts.append("match \(at + 1) of \(p.matchLines.count) (⌘G)")
        } else if !p.matchLines.isEmpty {
            parts.append(p.matchLines.count == 1 ? "1 match" : "\(p.matchLines.count) matches")
        }
        if let note = p.note, !note.isEmpty { parts.append(note) }
        return parts.joined(separator: " · ")
    }
}

struct StatusBar: View {
    @Environment(SearchModel.self) private var model

    var body: some View {
        HStack(spacing: 10) {
            if model.indexing {
                IndexProgressView(activity: model.activity)
                Button("Stop") { model.cancelIndex() }
                    .buttonStyle(.link)
            } else if let s = model.stats {
                Text(indexText(s))
                    .lineLimit(1)
            }
            Spacer(minLength: 12)
            if let notice = model.notice {
                Text(notice)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } else if let r = model.response {
                // What the engine says about the search: a filter it could not understand, semantic
                // search falling back to words, a "did you mean".
                if let notice = r.notice, !notice.isEmpty {
                    Text(notice)
                        .foregroundStyle(.orange)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(notice)
                }
                Text("\(r.total.formatted()) results · \(r.strategy) · \(Int(r.elapsedMs.rounded())) ms" + (r.partial ? " · partial" : ""))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
    }

    private func indexText(_ s: IndexStats) -> String {
        var text = "\(s.files.formatted()) files · \(s.folders.formatted()) folders · \(s.withContent.formatted()) with text"
        if let last = s.lastIndexedAt {
            text += " · updated " + Date(timeIntervalSince1970: last / 1000).formatted(.relative(presentation: .named))
        }
        if let count = s.unreadableFolders?.count, count > 0 {
            text += " · couldn't read \(count) folders (check permissions)"
        }
        return text
    }
}

/// The only view that observes indexing progress, so progress ticks redraw just this.
struct IndexProgressView: View {
    let activity: IndexActivity

    var body: some View {
        ProgressView(value: activity.progress?.fraction)
            .progressViewStyle(.linear)
            .frame(width: 120)
        Text(text)
            .lineLimit(1)
            .truncationMode(.middle)
            .monospacedDigit()
    }

    private var text: String {
        guard let p = activity.progress else { return "Starting…" }
        if p.phase == "content", let waiting = p.waiting { return "Word index · waiting: \(waiting) · resumes on its own" }
        if p.phase == "meaning", let waiting = p.waiting { return "Semantic index (Granite) · waiting: \(waiting) · resumes on its own" }
        switch p.phase {
        case "scan", "starting": return "Scanning… \(p.scanned.formatted()) items"
        case "content": return "Word index: reading contents \(p.contentDone.formatted()) of \(p.contentTotal.formatted())"
        case "cleanup": return "Cleaning up…"
        case "meaning": return "Semantic index (Granite): \((p.meaning?.done ?? 0).formatted()) of \((p.meaning?.total ?? 0).formatted())"
        default: return "Indexing…"
        }
    }
}

struct EngineFailureView: View {
    @Environment(SearchModel.self) private var model
    let message: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(message)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
            Button("Restart Engine") { model.restartEngine() }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// "L12", "p3", "slide 2" or "sheet 1", as the terminal UI labels matches.
func location(of line: LineMatch, kind: String) -> String {
    switch kind {
    case "pdf", "ebook": return "p\(line.page)"
    case "slides": return "slide \(line.page)"
    case "sheet": return "sheet \(line.page)"
    default: return "L\(line.line)"
    }
}

func attributed(_ runs: [TextRun], trimLeading: Bool) -> AttributedString {
    var out = AttributedString()
    var first = true
    for run in runs {
        var text = run.text
        if first, trimLeading, !run.highlighted {
            text = String(text.drop(while: { $0 == " " || $0 == "\t" }))
        }
        first = false
        var piece = AttributedString(text)
        if run.highlighted {
            piece.backgroundColor = Color.yellow.opacity(0.35)
            piece.foregroundColor = Color.primary
        }
        out.append(piece)
    }
    return out
}
#endif
