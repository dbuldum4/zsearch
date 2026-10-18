#if os(macOS)
import AppKit
import ServiceManagement
import SwiftUI
import ZSearchKit

/// zsearch › Settings… (⌘,)
struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralSettings()
                .tabItem { Label("General", systemImage: "gearshape") }
            IndexSettings()
                .tabItem { Label("Index", systemImage: "externaldrive") }
            SemanticSettings()
                .tabItem { Label("Semantic", systemImage: "sparkle.magnifyingglass") }
        }
        .frame(width: 520)
    }
}

/// Which app this is: the full app, or the semantic-only one (`ZSearchSemanticOnly` in its Info.plist),
/// which has Semantic as its one search mode. Both run the same engine on the same index.
enum Edition {
    static let semanticOnly = Bundle.main.object(forInfoDictionaryKey: "ZSearchSemanticOnly") as? Bool ?? false
}

/// Preferences that belong to the app (not the engine), kept in UserDefaults.
enum AppSettings {
    static let showMenuBarItem = "showMenuBarItem"
    static let hotKey = "hotKey"
    /// Set when the chosen shortcut could not be registered (another app has it).
    static let hotKeyTaken = "hotKeyTaken"
    /// PDFs preview as their extracted text instead of their pages. The switch above the preview changes it too.
    static let pdfShowsText = "pdfShowsText"
    /// Word documents preview as their extracted text instead of their formatting. The switch above the preview changes it too.
    static let documentShowsText = "documentShowsText"
    static let ebookShowsText = "ebookShowsText"
    /// Images (and other files Quick Look shows) preview as the text read from them instead.
    static let imageShowsText = "imageShowsText"
    static let mediaShowsTranscript = "mediaShowsTranscript"
    static let wrapTextPreviews = "wrapTextPreviews"
    static let wrapPanelTextPreviews = "wrapPanelTextPreviews"
    /// The bundle identifier of the editor ⌘E opens files in; empty for the first one installed.
    static let editor = "editor"
    /// What the global shortcut shows (see `ShortcutTarget`).
    static let shortcutOpens = "shortcutOpens"
}

/// What the global shortcut shows.
enum ShortcutTarget: String {
    /// The floating panel (`QuickPanel`), over whatever app is in front.
    case panel
    case window
}

private struct GeneralSettings: View {
    @Environment(SearchModel.self) private var model
    @AppStorage(AppSettings.showMenuBarItem) private var showMenuBarItem = true
    @AppStorage(AppSettings.hotKey) private var hotKey = HotKeyChoice.optionSpace.rawValue
    @AppStorage(AppSettings.hotKeyTaken) private var hotKeyTaken = false
    @AppStorage(AppSettings.pdfShowsText) private var pdfShowsText = false
    @AppStorage(AppSettings.documentShowsText) private var documentShowsText = false
    @AppStorage(AppSettings.ebookShowsText) private var ebookShowsText = false
    @AppStorage(AppSettings.wrapTextPreviews) private var wrapTextPreviews = true
    @AppStorage(AppSettings.wrapPanelTextPreviews) private var wrapPanelTextPreviews = true
    @AppStorage(AppSettings.editor) private var editor = ""
    @AppStorage(AppSettings.shortcutOpens) private var shortcutOpens = ShortcutTarget.panel.rawValue
    @State private var openAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginError: String?

    var body: some View {
        Form {
            if !Edition.semanticOnly {
                Picker("Search mode at start", selection: defaultMode) {
                    Text("Find (exact text, /regex/)").tag(Mode.find)
                    Text("Fuzzy (forgiving names)").tag(Mode.fuzzy)
                    if model.config?.semantic?.enabled == true {
                        Text("Semantic (describe what you're looking for)").tag(Mode.semantic)
                    }
                }
            }
            Picker("Preview PDFs as", selection: $pdfShowsText) {
                Text("Pages").tag(false)
                Text("Text").tag(true)
            }
            Picker("Preview Word documents as", selection: $documentShowsText) {
                Text("Document").tag(false)
                Text("Text").tag(true)
            }
            Picker("Preview EPUB and MOBI books as", selection: $ebookShowsText) {
                Text("Reading").tag(false)
                Text("Text").tag(true)
            }
            Toggle("Wrap text in the floating search panel", isOn: $wrapPanelTextPreviews)
            Toggle("Wrap text in the main window", isOn: $wrapTextPreviews)
            Picker("Open code in (⌘E)", selection: $editor) {
                Text("First editor installed").tag("")
                ForEach(installedEditors) { Text($0.name).tag($0.bundleID) }
            }
            Picker("Shortcut to show zsearch", selection: $hotKey) {
                ForEach(HotKeyChoice.allCases) { Text($0.label).tag($0.rawValue) }
            }
            Picker("The shortcut opens", selection: $shortcutOpens) {
                Text("A floating search panel").tag(ShortcutTarget.panel.rawValue)
                Text("The main window").tag(ShortcutTarget.window.rawValue)
            }
            .disabled(hotKey == HotKeyChoice.off.rawValue)
            if hotKeyTaken {
                Text("Another app already uses this shortcut. Pick a different one, or change it in that app.")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            Toggle("Show zsearch in the menu bar", isOn: $showMenuBarItem)
            Text(showMenuBarItem ? "zsearch keeps running in the menu bar when its window is closed." : "Closing the window quits zsearch.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Toggle("Open at login", isOn: $openAtLogin)
                .onChange(of: openAtLogin) { _, on in setOpenAtLogin(on) }
            if let loginError {
                Text(loginError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .formStyle(.grouped)
    }

    private var installedEditors: [EditorApp] {
        EditorApp.known.filter { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0.bundleID) != nil }
    }

    private var defaultMode: Binding<Mode> {
        Binding(
            get: { Mode(rawValue: model.config?.defaultMode ?? "find") ?? .find },
            set: { model.updateConfig(ConfigPatch(defaultMode: $0.rawValue), reindex: false) }
        )
    }

    private func setOpenAtLogin(_ on: Bool) {
        // Also called when a failure below puts the toggle back: nothing to do then.
        guard on != (SMAppService.mainApp.status == .enabled) else { return }
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            loginError = nil
        } catch {
            loginError = "Could not change this: \(error.localizedDescription)"
            openAtLogin = SMAppService.mainApp.status == .enabled
        }
    }
}

/// Semantic search uses Granite locally after its current index is complete.
private struct SemanticSettings: View {
    @Environment(SearchModel.self) private var model
    @State private var confirmRemove = false

    var body: some View {
        Form {
            Section {
                Text("Finds files by what they are about, not only by their words: “the lease for the flat in Lisbon”. It runs on this Mac with IBM's Granite embedding model (Apache 2.0), downloaded when zsearch starts. Granite reads stored text in the background. Word matches remain available until semantic indexing finishes. Results mix meaning with your words, using DigUp's ranking. Find and Fuzzy don't need it.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                if let s = model.semantic {
                    if s.enabled && s.model.ready {
                        if let i = s.index {
                            LabeledContent("Granite index", value: "\(i.files.formatted()) files (\(ByteCountFormatter.string(fromByteCount: Int64(i.bytes), countStyle: .file)))")
                            if i.partial > 0 {
                                LabeledContent("Long files to finish", value: i.partial.formatted())
                            }
                            if let error = i.error {
                                Text("Last update stopped: \(error)")
                                    .font(.caption)
                                    .foregroundStyle(.red)
                            }
                        }
                        if s.index == nil {
                            Text("Files are read for semantic search with the next index update.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let blocked = s.blocked {
                            Text("Not running: \(blocked)")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                        Toggle("Source code and data files", isOn: semanticFlag(\.code))
                            .help("Off by default: words find code better than meaning does.")
                        HStack {
                            Button("Build Semantic Index Only") { model.buildMeaningIndex() }
                                .disabled(model.indexing || s.blocked != nil)
                            Spacer()
                            // The semantic-only app downloads the model again at its next start.
                            if !Edition.semanticOnly {
                                Button("Turn Off and Delete Model…", role: .destructive) { confirmRemove = true }
                                    .disabled(model.indexing)
                            }
                        }
                        Text("Builds only the semantic index from text earlier updates already read. It does not scan folders or rebuild the word index, so the word index only changes when you run a full update.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if model.downloadingModel {
                        if let d = model.semanticDownload, d.total > 0 {
                            ProgressView(value: Double(d.received), total: Double(d.total)) {
                                Text("Downloading \(d.file): \(ByteCountFormatter.string(fromByteCount: Int64(d.received), countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: Int64(d.total), countStyle: .file))")
                            }
                        } else {
                            ProgressView("Starting the download…")
                        }
                        HStack {
                            Spacer()
                            Button("Cancel") { model.cancelSemanticInstall() }
                        }
                    } else {
                        HStack {
                            Text(ByteCountFormatter.string(fromByteCount: Int64(s.model.bytes), countStyle: .file) + " download")
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button("Download and Turn On") { model.installSemantic() }
                                .keyboardShortcut(.defaultAction)
                        }
                        if s.helper == nil {
                            Text("This copy of zsearch has no embedding helper. Granite needs it to build and search the semantic index.")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                    }
                } else {
                    ProgressView()
                }
            } header: {
                Text("Semantic search")
            }
        }
        .formStyle(.grouped)
        .onAppear { Task { await model.refreshSemantic() } }
        .confirmationDialog("Turn off semantic search?", isPresented: $confirmRemove) {
            Button("Turn Off and Delete", role: .destructive) { model.removeSemantic() }
        } message: {
            Text("The model and what was read for semantic search are deleted, and it is no longer downloaded when zsearch starts. Find and Fuzzy keep working.")
        }
    }

    private func semanticFlag(_ path: WritableKeyPath<SemanticConfig, Bool>) -> Binding<Bool> {
        Binding(
            get: { model.config?.semantic?[keyPath: path] ?? false },
            set: { on in
                guard var semantic = model.config?.semantic else { return }
                semantic[keyPath: path] = on
                model.updateConfig(ConfigPatch(semantic: semantic), reindex: true)
            }
        )
    }
}

private struct IndexSettings: View {
    @Environment(SearchModel.self) private var model
    @State private var confirmRebuild = false
    @State private var excludeText = ""
    @State private var transcriptionLanguage = ""

    var body: some View {
        Form {
            Section {
                ForEach(model.config?.roots ?? [], id: \.self) { root in
                    HStack {
                        Image(systemName: "folder")
                            .foregroundStyle(.secondary)
                        Text(root)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Button {
                            setRoots((model.config?.roots ?? []).filter { $0 != root })
                        } label: {
                            Image(systemName: "minus.circle")
                        }
                        .buttonStyle(.borderless)
                        .disabled((model.config?.roots.count ?? 0) <= 1)
                        .help("Stop indexing this folder")
                    }
                }
                Button("Add Folder…", action: addFolders)
            } header: {
                Text("Folders")
            }

            Section {
                Toggle("Read the text inside files", isOn: flag(\.content.enabled) { ConfigPatch(content: ContentConfig(enabled: $0)) })
                Toggle("Read text in images and scanned PDFs", isOn: ocr)
                    .disabled(model.config?.content.enabled != true)
                    .help("Recognizes text in screenshots, photos and scans (OCR), after the other files are read.")
                Toggle("Index photo metadata, Finder tags and PDF titles", isOn: metadata)
                    .disabled(model.config?.content.enabled != true)
                Toggle("Transcribe speech in audio and video", isOn: transcription)
                    .disabled(model.config?.content.enabled != true)
                    .help("On-device on supported Macs with macOS 26+. Apple may download language assets on first use. Reads up to two hours per recording, after documents and images.")
                TextField("Transcript language", text: $transcriptionLanguage, prompt: Text("System language"))
                    .disabled(model.config?.content.enabled != true || model.config?.content.transcribe == false)
                    .onAppear { transcriptionLanguage = model.config?.content.transcriptionLocale ?? "" }
                    .onChange(of: model.config?.content.transcriptionLocale) { _, locale in transcriptionLanguage = locale ?? "" }
                    .onSubmit {
                        guard let content = model.config?.content else { return }
                        model.updateConfig(ConfigPatch(content: ContentConfig(enabled: content.enabled, transcriptionLocale: transcriptionLanguage.trimmingCharacters(in: .whitespaces))), reindex: true)
                    }
                    .help("Language code such as en-US or tr-TR; press Return to save. Leave empty for the system language; language is not detected automatically.")
                Toggle("Include hidden files and folders", isOn: flag(\.includeHidden) { ConfigPatch(includeHidden: $0) })
                Toggle("Skip what .gitignore files exclude", isOn: flag(\.respectGitignore) { ConfigPatch(respectGitignore: $0) })
                Toggle("Follow symbolic links within indexed folders", isOn: flag(\.followSymlinks) { ConfigPatch(followSymlinks: $0) })
                Toggle("Read files in iCloud Drive and other cloud folders", isOn: flag(\.cloudContent) { ConfigPatch(cloudContent: $0) })
                    .help("Reading an online-only file downloads it.")
                VStack(alignment: .leading, spacing: 4) {
                    Text("Skip these (one per line: a folder, or a pattern like *.log or node_modules)")
                    TextEditor(text: $excludeText)
                        .font(.system(.body, design: .monospaced))
                        .frame(height: 64)
                    HStack {
                        Spacer()
                        Button("Save", action: saveExcludes)
                            .disabled(excludeList == (model.config?.exclude ?? []))
                    }
                }
                Toggle("Pause big automatic updates in Low Power Mode or when the Mac is hot", isOn: pauseOnLowPower)
                    .help("Updates of 1,000 files or more that start on their own wait and then pick up where they left off. Update Index Now never waits.")
                Toggle("Pause big automatic updates on battery", isOn: pauseOnBattery)
                Picker("Update the index", selection: refresh) {
                    Text("Only when I ask").tag(0.0)
                    Text("When files change").tag(Self.onChangeOnly)
                    Text("Every 15 minutes").tag(15.0)
                    Text("Every hour").tag(60.0)
                    Text("Every 4 hours").tag(240.0)
                    Text("Once a day").tag(1440.0)
                }
                if (model.config?.autoRefreshMinutes ?? 60) > 0 {
                    Toggle("Also update as files change", isOn: watchFiles)
                        .help("Watches the folders while zsearch is open.")
                }
            } header: {
                Text("What to index")
            }

            Section {
                if let s = model.stats {
                    LabeledContent("Files", value: "\(s.files.formatted()) files, \(s.folders.formatted()) folders")
                    LabeledContent("With text", value: "\(s.withContent.formatted()) (\(ByteCountFormatter.string(fromByteCount: Int64(s.contentBytes), countStyle: .file)))")
                    LabeledContent("Index size", value: ByteCountFormatter.string(fromByteCount: Int64(s.dbBytes), countStyle: .file))
                    if let last = s.lastIndexedAt {
                        LabeledContent("Updated", value: Date(timeIntervalSince1970: last / 1000).formatted(.relative(presentation: .named)))
                    }
                }
                HStack {
                    if model.indexing && !model.refreshingChangedFiles {
                        if model.activity.progress?.waiting != nil {
                            Button("Index Now") { model.indexNow() }
                                .help("Stop waiting for power and read the files now.")
                        }
                        Button("Stop Indexing") { model.cancelIndex() }
                    } else {
                        Button(model.needsReindex ? "Update Index to Apply Changes" : "Update Index Now") { model.startIndex() }
                            .keyboardShortcut(model.needsReindex ? .defaultAction : nil)
                        if model.indexing { Button("Stop Indexing") { model.cancelIndex() } }
                    }
                    Button("Rebuild…") { confirmRebuild = true }
                        .disabled(model.indexing && !model.refreshingChangedFiles)
                    Spacer()
                    IndexProblemsButton(title: "Problems…")
                        .help("Files whose contents search cannot find, and why")
                    Button("Show in Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([SearchModel.indexFolder.appendingPathComponent("index.db")])
                    }
                }
            } header: {
                Text("Index")
            }
        }
        .formStyle(.grouped)
        .onAppear {
            excludeText = (model.config?.exclude ?? []).joined(separator: "\n")
            Task { await model.refreshStats() }
        }
        .confirmationDialog("Rebuild the index from scratch?", isPresented: $confirmRebuild) {
            Button("Rebuild", role: .destructive) { model.startIndex(rebuild: true) }
        } message: {
            Text("Every file is read again. Search keeps working, with fewer results until it finishes.")
        }
    }

    private var excludeList: [String] {
        excludeText.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private func saveExcludes() {
        model.updateConfig(ConfigPatch(exclude: excludeList), reindex: true)
    }

    /// A toggle bound to a config flag; changing it saves and asks for an index update.
    private func flag(_ path: KeyPath<Config, Bool>, _ patch: @escaping (Bool) -> ConfigPatch) -> Binding<Bool> {
        Binding(
            get: { model.config?[keyPath: path] ?? false },
            set: { model.updateConfig(patch($0), reindex: true) }
        )
    }

    /// Applies to a run already going, within half a minute: no index update needed.
    private var pauseOnLowPower: Binding<Bool> {
        Binding(
            get: { model.config?.pauseOnLowPower ?? true },
            set: { model.updateConfig(ConfigPatch(pauseOnLowPower: $0), reindex: false) }
        )
    }

    private var pauseOnBattery: Binding<Bool> {
        Binding(
            get: { model.config?.pauseOnBattery ?? false },
            set: { model.updateConfig(ConfigPatch(pauseOnBattery: $0), reindex: false) }
        )
    }

    private var transcription: Binding<Bool> {
        Binding(
            get: { model.config?.content.transcribe ?? true },
            set: { on in
                guard let content = model.config?.content else { return }
                model.updateConfig(ConfigPatch(content: ContentConfig(enabled: content.enabled, transcribe: on)), reindex: true)
            }
        )
    }

    private var metadata: Binding<Bool> {
        Binding(
            get: { model.config?.content.metadata ?? false },
            set: { on in
                guard let content = model.config?.content else { return }
                model.updateConfig(ConfigPatch(content: ContentConfig(enabled: content.enabled, metadata: on)), reindex: true)
            }
        )
    }

    private var ocr: Binding<Bool> {
        Binding(
            get: { model.config?.content.ocr ?? false },
            set: { on in
                guard let content = model.config?.content else { return }
                model.updateConfig(ConfigPatch(content: ContentConfig(enabled: content.enabled, ocr: on)), reindex: true)
            }
        )
    }

    /// The picker's tag for watching files with no schedule (`autoRefreshMinutes` 0, live updates on).
    private static let onChangeOnly = -1.0

    /// "Only when I ask" turns off both the schedule and file watching. Moving between schedules
    /// keeps the watching choice; leaving "Only when I ask" for a schedule turns watching back on.
    private var refresh: Binding<Double> {
        Binding(
            get: {
                let minutes = model.config?.autoRefreshMinutes ?? 60
                return minutes == 0 && model.config?.liveUpdates ?? true ? Self.onChangeOnly : minutes
            },
            set: { choice in
                let watch: Bool? = switch choice {
                case 0: false
                case Self.onChangeOnly: true
                default: model.manualIndexing ? true : nil
                }
                model.updateConfig(ConfigPatch(autoRefreshMinutes: max(choice, 0), liveUpdates: watch), reindex: false)
            }
        )
    }

    private var watchFiles: Binding<Bool> {
        Binding(
            get: { model.config?.liveUpdates ?? true },
            set: { model.updateConfig(ConfigPatch(liveUpdates: $0), reindex: false) }
        )
    }

    private func setRoots(_ roots: [String]) {
        guard !roots.isEmpty else { return }
        model.updateConfig(ConfigPatch(roots: roots), reindex: true)
    }

    private func addFolders() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Add"
        guard panel.runModal() == .OK else { return }
        var roots = model.config?.roots ?? []
        for url in panel.urls {
            let path = tildePath(url.path)
            if !roots.contains(path) { roots.append(path) }
        }
        setRoots(roots)
    }
}

/// `path` with the home folder written as ~, as the engine's config does.
func tildePath(_ path: String) -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    if path == home { return "~" }
    if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
    return path
}
#endif
