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
        // Semantic search runs the model on the query: wait for a pause in typing.
        didSet { if query != oldValue { scheduleSearch(delay: mode == .semantic ? 0.1 : 0.016) } }
    }
    var mode: Mode = Edition.semanticOnly ? .semantic : .find {
        didSet { if mode != oldValue { scheduleSearch(delay: 0) } }
    }
    var selection: SearchHit.ID? {
        didSet {
            guard selection != oldValue else { return }
            updateHasSelection()
            loadPreview()
            // Quick Look follows the selection while it is open, as in Finder.
            if quickLookURL != nil { quickLookURL = selectedHit.map { URL(fileURLWithPath: $0.path) } }
        }
    }
    /// The file shown in Quick Look, or nil when it is closed.
    var quickLookURL: URL?
    /// Quick Look was opened from the floating panel, not the main window.
    private(set) var quickLookInPanel = false
    var showSetup = false
    /// Bumped to ask the search field to take focus.
    private(set) var focusRequest = 0
    private(set) var response: SearchResponse? {
        didSet { updateHasSelection() }
    }
    /// Whether a result is selected. The menus read this rather than `selectedHit`, which
    /// changes with every move through the list.
    private(set) var hasSelection = false
    private(set) var preview: FilePreview?
    private(set) var stats: IndexStats?
    private(set) var config: Config?
    /// Semantic search: its model, helper and index; and the model download, while one runs.
    private(set) var semantic: SemanticStatus?
    private(set) var semanticDownload: DownloadProgress?
    private(set) var downloadingModel = false
    private(set) var indexing = false
    private(set) var firstRun = false
    private(set) var notice: String?
    private(set) var engineFailure: String?
    /// Settings changed that only apply after the next index update.
    private(set) var needsReindex = false
    /// Counts the settings changes that need an index update. An index run uses the settings it
    /// started with, so it applies the changes counted up to its start and no later ones.
    @ObservationIgnored private var settingsRevision = 0
    @ObservationIgnored private var indexedRevision = 0
    /// A saved setup or exclusion requested a full update while another run was still using old settings.
    @ObservationIgnored private var indexAfterCurrentRun = false
    /// Stop also invalidates indexing requested by a save whose engine reply is still in flight.
    @ObservationIgnored private var indexCancellationGeneration = 0

    let activity = IndexActivity()

    @ObservationIgnored private var engine: EngineConnection?
    /// Bumped on every start, so an old engine's exit is not mistaken for the current one's.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var previewTask: Task<Void, Never>?
    @ObservationIgnored private var prefetchTask: Task<Void, Never>?
    /// Readies the preview about to show (see `PreviewPreparation`).
    @ObservationIgnored private var displayTask: Task<Void, Never>?
    /// Re-runs the search after the index changes; separate from `searchTask` so it never delays typing.
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    /// What the current (or pending) preview is for, so unchanged results do not reload it.
    @ObservationIgnored private var previewKey: PreviewKey?
    /// Recent previews, including prefetched neighbours of the selection: moving through the
    /// list shows them without a round trip to the engine.
    @ObservationIgnored private var previewCache: [PreviewKey: FilePreview] = [:]
    @ObservationIgnored private var previewCacheOrder: [PreviewKey] = []
    /// Bumped whenever the index changes: preview replies requested before that are dropped.
    @ObservationIgnored private var previewEpoch = 0
    /// Checks every minute whether the "Update the index" setting calls for an update.
    @ObservationIgnored private var autoUpdateTask: Task<Void, Never>?
    /// When the last automatic update was started (ms since 1970).
    @ObservationIgnored private var lastAutoUpdate: Double?
    @ObservationIgnored private var engineRestartTask: Task<Void, Never>?
    @ObservationIgnored private var automaticRestartUsed = false
    /// Opens the main window; set by a view that has the `openWindow` action.
    @ObservationIgnored var openMainWindow: (() -> Void)?

    var hits: [SearchHit] { response?.hits ?? [] }
    var selectedHit: SearchHit? { hits.first { $0.id == selection } }

    /// A preview is for a file as the result list shows it: one changed on disk since (or whose
    /// first match moved, its text having been read since) needs a new one.
    private struct PreviewKey: Hashable {
        var file: Int
        var path: String
        var size: Int
        var mtime: Double
        var focus: Int?
        var query: String
        var mode: Mode

        init(_ hit: SearchHit, query: String, mode: Mode) {
            file = hit.id
            path = hit.path
            size = hit.size
            mtime = hit.mtime
            focus = hit.lines.first?.line
            self.query = query
            self.mode = mode
        }
    }

    private func updateHasSelection() {
        let selected = selection != nil && hits.contains { $0.id == selection }
        if selected != hasSelection { hasSelection = selected }
    }

    // MARK: - Engine

    /// The query text sent to the engine. The semantic-only app never lets a prefix switch modes.
    private static func sent(_ query: String) -> String {
        Edition.semanticOnly ? QueryFilters.semanticOnly(query) : query
    }

    /// The engine binary: in debug builds $ZSEARCH_ENGINE when set (`swift run`), else the one
    /// inside the app bundle. A released app never runs a binary named by its environment.
    static func engineURL() -> URL? {
        #if DEBUG
        if let path = ProcessInfo.processInfo.environment["ZSEARCH_ENGINE"], !path.isEmpty {
            return URL(fileURLWithPath: path)
        }
        #endif
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
        indexAfterCurrentRun = false
        indexCancellationGeneration += 1
        engineRestartTask?.cancel()
        engineRestartTask = nil
        generation += 1
        autoUpdateTask?.cancel()
        autoUpdateTask = nil
        engine?.stop()
        engine = nil
    }

    func restartEngine() {
        automaticRestartUsed = false
        stop()
        start()
    }

    private func engineExited(_ error: EngineError) {
        indexAfterCurrentRun = false
        indexCancellationGeneration += 1
        engine = nil
        indexing = false
        activity.progress = nil
        engineFailure = error.localizedDescription
        guard !automaticRestartUsed else { return }
        automaticRestartUsed = true
        engineRestartTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            self?.start()
        }
    }

    private func handle(_ message: Message) {
        switch message {
        case let .ready(ready):
            config = ready.config
            firstRun = ready.firstRun
            mode = Edition.semanticOnly ? .semantic : Mode(rawValue: ready.config.defaultMode) ?? .find
            Task {
                await refreshStats()
                await refreshSemantic()
                // Semantic search's Granite model downloads when the app starts, unless it was turned off.
                // The semantic-only app always downloads it: it has no other way to search.
                if let s = semantic, !s.declined || Edition.semanticOnly, !s.model.ready { installSemantic() }
                if ready.firstRun {
                    showSetup = true
                } else if indexIsStale {
                    startIndex(background: true)
                }
                scheduleSearch(delay: 0)
                startAutoUpdates()
            }
        case let .indexProgress(p):
            if !indexing { indexing = true }
            activity.progress = p
        case let .indexDone(done):
            indexing = false
            activity.progress = nil
            let followUp = indexAfterCurrentRun
            indexAfterCurrentRun = false
            switch done.status {
            case "done":
                // Settings changed during the run still wait for the next one.
                if indexedRevision == settingsRevision { needsReindex = false }
                if let p = done.progress, let m = p.meaning, p.scanned == 0 {
                    show("Semantic index updated · \(m.done.formatted()) files read · \(m.embedded.formatted()) passages embedded, \(m.reused.formatted()) reused")
                } else if let p = done.progress {
                    let changed = p.added + p.updated + p.removed
                    show("Index updated · \(p.scanned.formatted()) items scanned" + (changed > 0 ? " · \(changed.formatted()) changed" : ""))
                }
            case "cancelled": show("Indexing stopped")
            case "locked": show("Another zsearch process is updating the index")
            default: show("Indexing failed: \(done.error ?? "unknown error")")
            }
            clearPreviewCache()
            Task {
                await refreshStats()
                await refreshSemantic()
            }
            scheduleSearch(delay: 0)
            if followUp { startIndex() }
        case let .semanticDownload(d):
            semanticDownload = d
        case let .refreshed(_, changed):
            // Cached previews stay: one for a file that changed no longer matches its result.
            if changed { scheduleRefresh() }
        case let .error(text):
            show(text)
        default:
            break
        }
    }

    // MARK: - Searching

    func scheduleSearch(delay: Double = 0.016) {
        searchTask?.cancel()
        // Previews of the results around the selection can wait until the typing stops.
        prefetchTask?.cancel()
        prefetchTask = nil
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
            guard case let .results(r) = try await engine.request(.search(query: Self.sent(query), mode: mode)) else { return }
            guard query == self.query, mode == self.mode else { return }
            // Same hits as before (typical for a refresh): keep the current list and preview untouched.
            if let current = response, current.query == r.query, current.resolved == r.resolved, current.hits == r.hits, current.notice == r.notice, current.error == r.error { return }
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

    /// `focusLine`: the line to show rather than the hit's first match, as after a jump to another.
    private func loadPreview(focusLine: Int? = nil) {
        guard let hit = selectedHit, let engine else {
            previewTask?.cancel()
            previewTask = nil
            displayTask?.cancel()
            displayTask = nil
            previewKey = nil
            preview = nil
            return
        }
        let key = PreviewKey(hit, query: query, mode: mode)
        guard key != previewKey else { return }
        previewTask?.cancel()
        previewTask = nil
        previewKey = key
        // The cache holds previews at the hit's first match only.
        let focus = focusLine ?? key.focus
        let cacheable = focus == key.focus
        if cacheable, let cached = previewCache[key] {
            display(cached, for: key)
            prefetchAround()
            return
        }
        // The previous preview stays on screen until this one arrives, so switching files never flashes blank.
        let request = Request.preview(file: hit.id, query: Self.sent(query), mode: mode, focusLine: focus)
        let epoch = previewEpoch
        previewTask = Task { [weak self] in
            let reply = try? await engine.request(request)
            guard !Task.isCancelled, let self, self.previewKey == key, self.previewEpoch == epoch else { return }
            self.previewTask = nil
            guard case let .preview(p)? = reply else { return }
            if cacheable { self.remember(p, for: key) }
            self.display(p, for: key)
            self.prefetchAround()
        }
    }

    /// Show a preview once what the pane shows for it is ready: a PDF opened, a Word file read,
    /// text styled, all off the main thread. Until then the previous preview stays up.
    private func display(_ p: FilePreview, for key: PreviewKey) {
        displayTask?.cancel()
        displayTask = nil
        if PreviewPreparation.isReady(p) {
            preview = p
            return
        }
        displayTask = Task { [weak self] in
            await PreviewPreparation.prepare(p)
            guard !Task.isCancelled, let self, self.previewKey == key else { return }
            self.displayTask = nil
            self.preview = p
        }
    }

    /// Fetch the previews of the results around the selection, so ↑/↓ shows them instantly, and
    /// style their text ahead. Waits for a pause: while typing, each new result list would ask for
    /// previews nobody looks at, ahead of the searches in the engine's queue.
    private func prefetchAround() {
        guard let engine, let index = hits.firstIndex(where: { $0.id == selection }) else { return }
        let (query, mode) = (self.query, self.mode)
        let keys = hits[max(0, index - 2)..<min(hits.count, index + 4)]
            .map { PreviewKey($0, query: query, mode: mode) }
            .filter { previewCache[$0] == nil }
        guard !keys.isEmpty else { return }
        let epoch = previewEpoch
        prefetchTask?.cancel()
        prefetchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            // Each with its hit's first matching line, as `loadPreview` asks: the engine cannot always
            // find the match itself (a typo-tolerant one, say) and would show the top of the file.
            let request = Request.previews(files: keys.map(\.file), query: Self.sent(query), mode: mode, focusLines: keys.map(\.focus))
            guard case let .previews(list)? = try? await engine.request(request), !Task.isCancelled else { return }
            guard let self, query == self.query, mode == self.mode, self.previewEpoch == epoch else { return }
            let byFile = Dictionary(keys.map { ($0.file, $0) }, uniquingKeysWith: { first, _ in first })
            var fetched: [FilePreview] = []
            for p in list {
                guard let key = byFile[p.id] else { continue }
                self.remember(p, for: key)
                fetched.append(p)
            }
            for p in fetched {
                guard !Task.isCancelled else { return }
                await PreviewPreparation.prepareAhead(p)
            }
        }
    }

    private func remember(_ preview: FilePreview, for key: PreviewKey) {
        // A file without a preview may get one as indexing reads it: ask again next time.
        guard preview.message == nil || preview.isDir else { return }
        if previewCache.updateValue(preview, forKey: key) == nil { previewCacheOrder.append(key) }
        while previewCacheOrder.count > 128 {
            previewCache.removeValue(forKey: previewCacheOrder.removeFirst())
        }
    }

    /// Forget previews after the index changed, including those still on their way.
    private func clearPreviewCache() {
        previewCache.removeAll()
        previewCacheOrder.removeAll()
        previewEpoch += 1
        prefetchTask?.cancel()
        prefetchTask = nil
        // The selection's preview, shown or still on its way, predates the change: ask again, at
        // the match the pane shows.
        let shown = preview?.id == selection ? preview?.focusLine : nil
        previewKey = nil
        loadPreview(focusLine: shown)
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
        // "Only when I ask" never starts a build on its own, even when no run has
        // completed yet: a first or interrupted index waits for Update Index.
        guard !manualIndexing else { return false }
        guard let stats, stats.lastIndexedAt != nil else { return true }
        return AutoUpdate.isDue(minutes: config?.autoRefreshMinutes ?? 60, lastFullWalkAt: stats.lastFullWalkAt ?? stats.lastIndexedAt, now: Date().timeIntervalSince1970 * 1000)
    }

    /// Update the index whenever it gets older than the "Update the index" setting, for as long
    /// as the engine runs (the app may stay open for days in the menu bar).
    private func startAutoUpdates() {
        autoUpdateTask?.cancel()
        autoUpdateTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(AutoUpdate.checkInterval * 1_000_000_000))
                guard !Task.isCancelled, let self else { return }
                self.updateIfDue()
            }
        }
    }

    private func updateIfDue() {
        guard engine != nil, !indexing, !firstRun, !showSetup, let stats else { return }
        let now = Date().timeIntervalSince1970 * 1000
        guard AutoUpdate.isDue(minutes: config?.autoRefreshMinutes ?? 60, lastFullWalkAt: stats.lastFullWalkAt ?? stats.lastIndexedAt, lastAttempt: lastAutoUpdate, now: now) else { return }
        lastAutoUpdate = now
        startIndex(background: true)
    }

    func refreshStats() async {
        guard let engine else { return }
        if case let .stats(s)? = try? await engine.request(.stats) { stats = s }
    }

    // MARK: - Semantic search

    func refreshSemantic() async {
        guard let engine else { return }
        if case let .semantic(s)? = try? await engine.request(.semanticStatus) { semantic = s }
    }

    /// Download Granite and turn semantic search on; the engine then reads the files for it.
    func installSemantic() {
        guard let engine, !downloadingModel else { return }
        downloadingModel = true
        semanticDownload = nil
        Task {
            defer {
                downloadingModel = false
                semanticDownload = nil
            }
            do {
                let reply = try await engine.request(.semanticInstall)
                if case let .semantic(s) = reply { semantic = s }
                if case let .error(text) = reply { show(text) }
                if case let .config(c)? = try? await engine.request(.config) { config = c }
                scheduleSearch(delay: 0)
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    func cancelSemanticInstall() {
        guard let engine else { return }
        Task { _ = try? await engine.request(.semanticCancelInstall) }
    }

    func removeSemantic() {
        guard let engine else { return }
        Task {
            do {
                let reply = try await engine.request(.semanticRemove)
                if case let .semantic(s) = reply { semantic = s }
                if case let .error(text) = reply { show(text) }
                if case let .config(c)? = try? await engine.request(.config) { config = c }
                if mode == .semantic { scheduleSearch(delay: 0) }
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    /// `background`: the app started it on its own, so a big one may wait on power.
    func startIndex(rebuild: Bool = false, background: Bool = false, afterCurrentRun: Bool = false) {
        guard let engine else { return }
        if indexing {
            if afterCurrentRun { indexAfterCurrentRun = true }
            return
        }
        indexing = true
        indexedRevision = settingsRevision
        Task {
            do {
                _ = try await engine.request(rebuild ? .rebuildIndex : background ? .backgroundIndex : .index)
            } catch {
                indexing = false
                show(error.localizedDescription)
            }
        }
    }

    /// Build only the Granite semantic index, from text earlier runs already read:
    /// no scanning and no word-index pass, so testing meaning never re-reads files.
    func buildMeaningIndex() {
        guard let engine, !indexing else { return }
        indexing = true
        Task {
            do {
                _ = try await engine.request(.meaningIndex)
            } catch {
                indexing = false
                show(error.localizedDescription)
            }
        }
    }

    /// The update going on, which waits on power, carries on now.
    func indexNow() {
        guard let engine else { return }
        Task { _ = try? await engine.request(.index) }
    }

    func cancelIndex() {
        // An explicit Stop also cancels the queued update, so it cannot restart indexing.
        indexAfterCurrentRun = false
        indexCancellationGeneration += 1
        guard let engine else { return }
        Task { _ = try? await engine.request(.cancelIndex) }
    }

    /// Save settings. `reindex` marks changes that only apply after the next index update.
    func updateConfig(_ patch: ConfigPatch, reindex: Bool, indexAfterSaving: Bool = false) {
        guard let engine else { return }
        let cancellation = indexCancellationGeneration
        if reindex { settingsRevision += 1 }
        Task {
            do {
                if case let .config(c) = try await engine.request(.setConfig(patch)) {
                    config = c
                    clearPreviewCache()
                    scheduleSearch(delay: 0)
                }
                if reindex { needsReindex = true }
                if indexAfterSaving, cancellation == indexCancellationGeneration { startIndex(afterCurrentRun: true) }
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    /// How long a first index of these folders takes, in words, or nil if it could not be counted
    /// (or a newer request superseded this one).
    func estimate(roots: [String]) async -> String? {
        guard let engine, !roots.isEmpty else { return nil }
        guard case let .estimate(reply) = try? await engine.request(.estimate(roots: roots)) else { return nil }
        return reply.text
    }

    /// Update the index only when asked: no schedule and no file watching.
    var manualIndexing: Bool {
        config?.autoRefreshMinutes == 0 && config?.liveUpdates == false
    }

    /// Save what to index (first run or File › Choose Folders…) and start indexing. With
    /// "Only when I ask", a later change waits for Update Index, as other settings do.
    func applySetup(roots: [String], readContents: Bool) {
        guard let engine else { return }
        let waits = !firstRun && manualIndexing
        let cancellation = indexCancellationGeneration
        settingsRevision += 1
        Task {
            do {
                let patch = ConfigPatch(roots: roots, content: ContentConfig(enabled: readContents))
                if case let .config(c) = try await engine.request(.setConfig(patch)) {
                    config = c
                    clearPreviewCache()
                    scheduleSearch(delay: 0)
                }
                firstRun = false
                showSetup = false
                needsReindex = true
                if !waits, cancellation == indexCancellationGeneration { startIndex(afterCurrentRun: true) }
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    // MARK: - Actions

    func open(_ hit: SearchHit) {
        QuickPanel.shared.fileOpened()
        NSWorkspace.shared.open(URL(fileURLWithPath: hit.path))
        if let engine { Task { _ = try? await engine.request(.opened(path: hit.path)) } }
    }

    func openSelected() {
        if let hit = selectedHit { open(hit) }
    }

    func reveal(_ hit: SearchHit) {
        QuickPanel.shared.fileOpened()
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: hit.path)])
    }

    func revealSelected() {
        if let hit = selectedHit { reveal(hit) }
    }

    // One assignment to `query`: each one schedules a search of its own.
    func sortResults(_ key: String) {
        query = QueryFilters.togglingSort(key, in: query)
        scheduleSearch(delay: 0)
    }
    func toggleFoldedPreview() {
        query = QueryFilters.togglingFold(in: query)
        clearPreviewCache()
        scheduleSearch(delay: 0)
    }
    func copyAllPaths() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(hits.map(\.path).joined(separator: "\n"), forType: .string)
    }
    func exclude(_ hit: SearchHit) {
        guard let config else { return }
        updateConfig(ConfigPatch(exclude: Array(Set(config.exclude + [hit.path])).sorted()), reindex: true, indexAfterSaving: true)
        response?.hits.removeAll { $0.path == hit.path || $0.path.hasPrefix(hit.path + "/") }
        if let count = response?.hits.count { response?.total = count }
        clearPreviewCache()
        // The excluded file's preview must not stay on screen.
        if selectedHit == nil { selection = hits.first?.id }
    }

    func copyPath(_ hit: SearchHit) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(hit.path, forType: .string)
        show("Copied \(hit.path)")
    }

    func copySelectedPath() {
        if let hit = selectedHit { copyPath(hit) }
    }

    /// Open or close Quick Look on the selected file (Space in the list, ⌘Y).
    func toggleQuickLook() {
        if quickLookURL == nil { quickLookInPanel = QuickPanel.shared.isKey }
        quickLookURL = quickLookURL == nil ? selectedHit.map { URL(fileURLWithPath: $0.path) } : nil
    }

    /// The editor ⌘E uses: the one picked in Settings if it is installed, else the first installed one.
    static func editor() -> (app: EditorApp, bundle: URL)? {
        let picked = UserDefaults.standard.string(forKey: AppSettings.editor) ?? ""
        let installed = EditorApp.known.compactMap { app in
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: app.bundleID).map { (app: app, bundle: $0) }
        }
        return installed.first { $0.app.bundleID == picked } ?? installed.first
    }

    /// Open a file in the code editor at its match: the line the preview shows, or the hit's
    /// first matching line. Documents and media open in their default app instead.
    func openInEditor(_ hit: SearchHit) {
        guard EditorApp.edits(kind: hit.kind, isDir: hit.isDir) else { return open(hit) }
        guard let editor = Self.editor() else {
            show("No code editor found (Visual Studio Code, Cursor, Zed, Sublime Text or Xcode)")
            return open(hit)
        }
        let app = editor.app
        let line = preview?.id == hit.id && !hit.isDir ? preview?.focusLine : hit.lines.first?.line
        let process = Process()
        process.executableURL = URL(fileURLWithPath: app.toolPath(bundle: editor.bundle))
        process.arguments = app.arguments(path: hit.path, line: line)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            QuickPanel.shared.fileOpened()
            if let engine { Task { _ = try? await engine.request(.opened(path: hit.path)) } }
        } catch {
            show("Could not open \(app.name): \(error.localizedDescription)")
        }
    }

    func openSelectedInEditor() {
        if let hit = selectedHit { openInEditor(hit) }
    }

    /// Show the next (`delta` 1) or previous (-1) match in the preview, going round at the ends.
    func jumpToMatch(by delta: Int) {
        guard let p = preview, let engine, p.id == selection, let key = previewKey else { return }
        let lines = Array(Set(p.matchLines)).sorted()
        guard !lines.isEmpty else { return }
        let target = delta > 0 ? (lines.first { $0 > p.focusLine } ?? lines[0]) : (lines.last { $0 < p.focusLine } ?? lines[lines.count - 1])
        guard target != p.focusLine else { return }
        // A match among the lines the preview holds, with enough of them around it to fill the
        // pane, needs no new lines from the engine.
        if let at = p.lines.firstIndex(where: { $0.n == target }),
           at >= Self.jumpContext || p.lines.first?.n == 1,
           p.lines.count - 1 - at >= Self.jumpContext || p.lines.last?.n == p.totalLines {
            previewTask?.cancel()
            previewTask = nil
            var next = p
            next.focusLine = target
            display(next, for: key)
            return
        }
        // The preview holds the lines around its focus only: ask for the ones around the target.
        let request = Request.preview(file: p.id, query: Self.sent(key.query), mode: key.mode, focusLine: target)
        let epoch = previewEpoch
        previewTask?.cancel()
        previewTask = Task { [weak self] in
            let reply = try? await engine.request(request)
            guard !Task.isCancelled, let self, self.previewKey == key, self.previewEpoch == epoch else { return }
            self.previewTask = nil
            if case let .preview(next)? = reply { self.display(next, for: key) }
        }
    }

    /// Lines a match needs above and below it to be shown from the preview's own lines.
    private static let jumpContext = 40

    /// Bring the search window forward (hotkey, menu bar, Dock), opening it if it was closed.
    func showMainWindow() {
        QuickPanel.shared.hide()
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
