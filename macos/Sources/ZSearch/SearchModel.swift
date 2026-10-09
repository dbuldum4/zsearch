#if os(macOS)
import AppKit
import Observation
import ZSearchKit

/// Indexing progress, kept apart from `SearchModel` because it changes many times a second.
@Observable
@MainActor
final class IndexActivity {
    var progress: IndexProgress?
}

/// App state. Talks to the bundled `zsearch serve` engine.
///
/// With Observation, a view is redrawn only when a property it read changes: typing redraws the
/// search field and the list, not the preview or the status bar.
@Observable
@MainActor
final class SearchModel {
    var query = "" {
        didSet { if query != oldValue { scheduleSearch() } }
    }
    var mode: Mode = .find {
        didSet { if mode != oldValue { scheduleSearch(delay: 0) } }
    }
    var selection: SearchHit.ID? {
        didSet { if selection != oldValue { loadPreview() } }
    }
    var showSetup = false
    /// Bumped to ask the search field to take focus.
    private(set) var focusRequest = 0
    private(set) var response: SearchResponse?
    private(set) var preview: FilePreview?
    private(set) var stats: IndexStats?
    private(set) var config: Config?
    private(set) var indexing = false
    private(set) var firstRun = false
    private(set) var notice: String?
    private(set) var engineFailure: String?
    /// Settings changed that only apply after the next index update.
    private(set) var needsReindex = false

    let activity = IndexActivity()

    @ObservationIgnored private var engine: EngineConnection?
    /// Bumped on every start, so an old engine's exit is not mistaken for the current one's.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var previewTask: Task<Void, Never>?
    @ObservationIgnored private var prefetchTask: Task<Void, Never>?
    /// Re-runs the search after the index changes; separate from `searchTask` so it never delays typing.
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    /// What the current (or pending) preview is for, so unchanged results do not reload it.
    @ObservationIgnored private var previewKey: PreviewKey?
    /// Recent previews, including prefetched neighbours of the selection: moving through the
    /// list shows them without a round trip to the engine.
    @ObservationIgnored private var previewCache: [PreviewKey: FilePreview] = [:]
    @ObservationIgnored private var previewCacheOrder: [PreviewKey] = []
    /// Opens the main window; set by a view that has the `openWindow` action.
    @ObservationIgnored var openMainWindow: (() -> Void)?

    var hits: [SearchHit] { response?.hits ?? [] }
    var selectedHit: SearchHit? { hits.first { $0.id == selection } }

    private struct PreviewKey: Hashable {
        var file: Int
        var query: String
        var mode: Mode
    }

    // MARK: - Engine

    /// The engine binary: $ZSEARCH_ENGINE when set (development), else the one inside the app bundle.
    static func engineURL() -> URL? {
        if let path = ProcessInfo.processInfo.environment["ZSEARCH_ENGINE"], !path.isEmpty {
            return URL(fileURLWithPath: path)
        }
        let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/zsearch")
        return FileManager.default.isExecutableFile(atPath: bundled.path) ? bundled : nil
    }

    /// Where the engine keeps its index (its default on macOS).
    static var indexFolder: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/zsearch")
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

    func restartEngine() {
        stop()
        start()
    }

    private func engineExited(_ error: EngineError) {
        engine = nil
        indexing = false
        activity.progress = nil
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
            if !indexing { indexing = true }
            activity.progress = p
        case let .indexDone(done):
            indexing = false
            activity.progress = nil
            switch done.status {
            case "done":
                needsReindex = false
                if let p = done.progress {
                    let changed = p.added + p.updated + p.removed
                    show("Index updated · \(p.scanned.formatted()) items scanned" + (changed > 0 ? " · \(changed.formatted()) changed" : ""))
                }
            case "cancelled": show("Indexing stopped")
            case "locked": show("Another zsearch process is updating the index")
            default: show("Indexing failed: \(done.error ?? "unknown error")")
            }
            clearPreviewCache()
            Task { await refreshStats() }
            scheduleSearch(delay: 0)
        case let .refreshed(_, changed):
            if changed {
                clearPreviewCache()
                scheduleRefresh()
            }
        case let .error(text):
            show(text)
        default:
            break
        }
    }

    // MARK: - Searching

    func scheduleSearch(delay: Double = 0.016) {
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            // One frame: coalesces key repeat; the engine cancels superseded searches anyway.
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            guard !Task.isCancelled else { return }
            await self?.runSearch()
        }
    }

    /// Search again because the index changed. While indexing, commits arrive several times a
    /// second; re-searching at most every 1.5 s keeps the list from churning under the pointer.
    private func scheduleRefresh() {
        guard refreshTask == nil else { return }
        let delay: UInt64 = indexing ? 1_500_000_000 : 300_000_000
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            self?.refreshTask = nil
            await self?.runSearch()
        }
    }

    private func runSearch() async {
        guard let engine else { return }
        let (query, mode) = (self.query, self.mode)
        do {
            guard case let .results(r) = try await engine.request(.search(query: query, mode: mode)) else { return }
            guard query == self.query, mode == self.mode else { return }
            // Same hits as before (typical for a refresh): keep the current list and preview untouched.
            if let current = response, current.query == r.query, current.resolved == r.resolved, current.hits == r.hits { return }
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
        guard let hit = selectedHit, let engine else {
            previewTask?.cancel()
            previewKey = nil
            preview = nil
            return
        }
        let key = PreviewKey(file: hit.id, query: query, mode: mode)
        guard key != previewKey else { return }
        previewTask?.cancel()
        previewKey = key
        if let cached = previewCache[key] {
            preview = cached
            prefetchAround()
            return
        }
        // The previous preview stays on screen until this one arrives, so switching files never flashes blank.
        let request = Request.preview(file: hit.id, query: query, mode: mode, focusLine: hit.lines.first?.line)
        previewTask = Task { [weak self] in
            guard case let .preview(p)? = try? await engine.request(request), !Task.isCancelled else { return }
            guard let self, self.previewKey == key else { return }
            self.remember(p, for: key)
            self.preview = p
            self.prefetchAround()
        }
    }

    /// Fetch the previews of the results around the selection, so ↑/↓ shows them instantly.
    private func prefetchAround() {
        guard let engine, let index = hits.firstIndex(where: { $0.id == selection }) else { return }
        let (query, mode) = (self.query, self.mode)
        let ids = hits[max(0, index - 2)..<min(hits.count, index + 4)]
            .map(\.id)
            .filter { previewCache[PreviewKey(file: $0, query: query, mode: mode)] == nil }
        guard !ids.isEmpty else { return }
        prefetchTask?.cancel()
        prefetchTask = Task { [weak self] in
            guard case let .previews(list)? = try? await engine.request(.previews(files: ids, query: query, mode: mode)), !Task.isCancelled else { return }
            guard let self, query == self.query, mode == self.mode else { return }
            for p in list where p.message == nil || p.isDir {
                self.remember(p, for: PreviewKey(file: p.id, query: query, mode: mode))
            }
        }
    }

    private func remember(_ preview: FilePreview, for key: PreviewKey) {
        if previewCache.updateValue(preview, forKey: key) == nil { previewCacheOrder.append(key) }
        while previewCacheOrder.count > 128 {
            previewCache.removeValue(forKey: previewCacheOrder.removeFirst())
        }
    }

    private func clearPreviewCache() {
        previewCache.removeAll()
        previewCacheOrder.removeAll()
    }

    func moveSelection(by delta: Int) {
        guard !hits.isEmpty else { return }
        let current = hits.firstIndex { $0.id == selection } ?? -1
        let next = min(max(current + delta, 0), hits.count - 1)
        selection = hits[next].id
    }

    func requestSearchFocus() {
        focusRequest += 1
    }

    // MARK: - Indexing and settings

    var indexIsStale: Bool {
        guard let last = stats?.lastIndexedAt else { return true }
        let maxAge = (config?.autoRefreshMinutes ?? 60) * 60_000
        return maxAge > 0 && Date().timeIntervalSince1970 * 1000 - last > maxAge
    }

    func refreshStats() async {
        guard let engine else { return }
        if case let .stats(s)? = try? await engine.request(.stats) { stats = s }
    }

    func startIndex(rebuild: Bool = false) {
        guard let engine, !indexing else { return }
        indexing = true
        Task {
            do {
                _ = try await engine.request(rebuild ? .rebuildIndex : .index)
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

    /// Save settings. `reindex` marks changes that only apply after the next index update.
    func updateConfig(_ patch: ConfigPatch, reindex: Bool) {
        guard let engine else { return }
        Task {
            do {
                if case let .config(c) = try await engine.request(.setConfig(patch)) { config = c }
                if reindex { needsReindex = true }
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    /// Save what to index (first run or File › Choose Folders…) and start indexing.
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

    /// Bring the search window forward (hotkey, menu bar, Dock), opening it if it was closed.
    func showMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        if let window = NSApp.windows.first(where: { ($0.identifier?.rawValue.hasPrefix("main") ?? false) && $0.canBecomeMain }) {
            window.makeKeyAndOrderFront(nil)
        } else {
            openMainWindow?()
        }
        requestSearchFocus()
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
