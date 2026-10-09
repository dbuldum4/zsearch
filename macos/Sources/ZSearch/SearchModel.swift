#if os(macOS)
import AppKit
import SwiftUI
import ZSearchKit

/// App state. Talks to the bundled `zsearch serve` engine.
@MainActor
final class SearchModel: ObservableObject {
    @Published var query = "" {
        didSet { if query != oldValue { scheduleSearch() } }
    }
    @Published var mode: Mode = .find {
        didSet { if mode != oldValue { scheduleSearch(delay: 0) } }
    }
    @Published var selection: SearchHit.ID? {
        didSet { if selection != oldValue { loadPreview() } }
    }
    @Published var showSetup = false
    @Published private(set) var response: SearchResponse?
    @Published private(set) var preview: FilePreview?
    @Published private(set) var stats: IndexStats?
    @Published private(set) var config: Config?
    @Published private(set) var progress: IndexProgress?
    @Published private(set) var indexing = false
    @Published private(set) var firstRun = false
    @Published private(set) var notice: String?
    @Published private(set) var engineFailure: String?

    private var engine: EngineConnection?
    /// Bumped on every start, so an old engine's exit is not mistaken for the current one's.
    private var generation = 0
    private var searchTask: Task<Void, Never>?
    private var previewTask: Task<Void, Never>?
    private var noticeTask: Task<Void, Never>?

    var hits: [SearchHit] { response?.hits ?? [] }
    var selectedHit: SearchHit? { hits.first { $0.id == selection } }

    // MARK: - Engine

    /// The engine binary: $ZSEARCH_ENGINE when set (development), else the one inside the app bundle.
    static func engineURL() -> URL? {
        if let path = ProcessInfo.processInfo.environment["ZSEARCH_ENGINE"], !path.isEmpty {
            return URL(fileURLWithPath: path)
        }
        let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/zsearch")
        return FileManager.default.isExecutableFile(atPath: bundled.path) ? bundled : nil
    }

    func start() {
        guard engine == nil else { return }
        engineFailure = nil
        guard let url = Self.engineURL() else {
            engineFailure = "The zsearch engine is missing from the app bundle."
            return
        }
        var env = ProcessInfo.processInfo.environment
        // Apps start with a minimal PATH; let the engine find Homebrew's pdftotext.
        env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"].joined(separator: ":")
        generation += 1
        let current = generation
        let connection = EngineConnection(
            executable: url,
            environment: env,
            onEvent: { [weak self] message in
                Task { @MainActor in
                    guard self?.generation == current else { return }
                    self?.handle(message)
                }
            },
            onExit: { [weak self] error in
                Task { @MainActor in
                    guard self?.generation == current else { return }
                    self?.engineExited(error)
                }
            }
        )
        do {
            try connection.start()
            engine = connection
        } catch {
            engineFailure = "Could not start the zsearch engine: \(error.localizedDescription)"
        }
    }

    func stop() {
        generation += 1
        engine?.stop()
        engine = nil
    }

    private func engineExited(_ error: EngineError) {
        engine = nil
        indexing = false
        progress = nil
        engineFailure = error.localizedDescription
    }

    private func handle(_ message: Message) {
        switch message {
        case let .ready(ready):
            config = ready.config
            firstRun = ready.firstRun
            mode = Mode(rawValue: ready.config.defaultMode) ?? .find
            Task {
                await refreshStats()
                if ready.firstRun {
                    showSetup = true
                } else if indexIsStale {
                    startIndex()
                }
                scheduleSearch(delay: 0)
            }
        case let .indexProgress(p):
            indexing = true
            progress = p
        case let .indexDone(done):
            indexing = false
            progress = nil
            switch done.status {
            case "done":
                if let p = done.progress {
                    let changed = p.added + p.updated + p.removed
                    show("Index updated · \(p.scanned.formatted()) items scanned" + (changed > 0 ? " · \(changed.formatted()) changed" : ""))
                }
            case "cancelled": show("Indexing stopped")
            case "locked": show("Another zsearch process is updating the index")
            default: show("Indexing failed: \(done.error ?? "unknown error")")
            }
            Task { await refreshStats() }
            scheduleSearch(delay: 0)
        case let .refreshed(_, changed):
            if changed { scheduleSearch(delay: 0.25) }
        case let .error(text):
            show(text)
        default:
            break
        }
    }

    // MARK: - Searching

    func scheduleSearch(delay: Double = 0.06) {
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            guard !Task.isCancelled else { return }
            await self?.runSearch()
        }
    }

    private func runSearch() async {
        guard let engine else { return }
        do {
            guard case let .results(r) = try await engine.request(.search(query: query, mode: mode)) else { return }
            guard r.query == query else { return }
            response = r
            if let id = selection, r.hits.contains(where: { $0.id == id }) {
                loadPreview()
            } else {
                selection = r.hits.first?.id
            }
        } catch {
            show(error.localizedDescription)
        }
    }

    private func loadPreview() {
        previewTask?.cancel()
        guard let hit = selectedHit, let engine else {
            preview = nil
            return
        }
        let request = Request.preview(file: hit.id, query: query, mode: mode, focusLine: hit.lines.first?.line)
        previewTask = Task { [weak self] in
            guard case let .preview(p)? = try? await engine.request(request), !Task.isCancelled else { return }
            if self?.selection == p.id { self?.preview = p }
        }
    }

    func moveSelection(by delta: Int) {
        guard !hits.isEmpty else { return }
        let current = hits.firstIndex { $0.id == selection } ?? -1
        let next = min(max(current + delta, 0), hits.count - 1)
        selection = hits[next].id
    }

    // MARK: - Indexing

    var indexIsStale: Bool {
        guard let last = stats?.lastIndexedAt else { return true }
        let maxAge = (config?.autoRefreshMinutes ?? 60) * 60_000
        return maxAge > 0 && Date().timeIntervalSince1970 * 1000 - last > maxAge
    }

    func refreshStats() async {
        guard let engine else { return }
        if case let .stats(s)? = try? await engine.request(.stats) { stats = s }
    }

    func startIndex() {
        guard let engine, !indexing else { return }
        indexing = true
        Task {
            do {
                _ = try await engine.request(.index)
            } catch {
                indexing = false
                show(error.localizedDescription)
            }
        }
    }

    func cancelIndex() {
        guard let engine else { return }
        Task { _ = try? await engine.request(.cancelIndex) }
    }

    /// Save what to index and start indexing.
    func applySetup(roots: [String], readContents: Bool) {
        guard let engine else { return }
        Task {
            do {
                let patch = ConfigPatch(roots: roots, content: ContentConfig(enabled: readContents))
                if case let .config(c) = try await engine.request(.setConfig(patch)) { config = c }
                firstRun = false
                showSetup = false
                startIndex()
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    // MARK: - Actions

    func open(_ hit: SearchHit) {
        NSWorkspace.shared.open(URL(fileURLWithPath: hit.path))
        if let engine { Task { _ = try? await engine.request(.opened(path: hit.path)) } }
    }

    func openSelected() {
        if let hit = selectedHit { open(hit) }
    }

    func reveal(_ hit: SearchHit) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: hit.path)])
    }

    func revealSelected() {
        if let hit = selectedHit { reveal(hit) }
    }

    func copyPath(_ hit: SearchHit) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(hit.path, forType: .string)
        show("Copied \(hit.path)")
    }

    func copySelectedPath() {
        if let hit = selectedHit { copyPath(hit) }
    }

    func restartEngine() {
        stop()
        start()
    }

    private func show(_ text: String) {
        notice = text
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }
}
#endif
