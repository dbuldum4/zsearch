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
        }
        .frame(width: 520)
    }
}

/// Preferences that belong to the app (not the engine), kept in UserDefaults.
enum AppSettings {
    static let showMenuBarItem = "showMenuBarItem"
    static let hotKey = "hotKey"
    /// Set when the chosen shortcut could not be registered (another app has it).
    static let hotKeyTaken = "hotKeyTaken"
    /// PDFs preview as their extracted text instead of their pages. The switch above the preview changes it too.
    static let pdfShowsText = "pdfShowsText"
    /// Images (and other files Quick Look shows) preview as the text read from them instead.
    static let imageShowsText = "imageShowsText"
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
    @AppStorage(AppSettings.editor) private var editor = ""
    @AppStorage(AppSettings.shortcutOpens) private var shortcutOpens = ShortcutTarget.panel.rawValue
    @State private var openAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginError: String?

    var body: some View {
        Form {
            Picker("Search mode at start", selection: defaultMode) {
                Text("Find (exact text, /regex/)").tag(Mode.find)
                Text("Fuzzy (forgiving names)").tag(Mode.fuzzy)
            }
            Picker("Preview PDFs as", selection: $pdfShowsText) {
                Text("Pages").tag(false)
                Text("Text").tag(true)
            }
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

private struct IndexSettings: View {
    @Environment(SearchModel.self) private var model
    @State private var confirmRebuild = false
    @State private var excludeText = ""

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
                    if model.indexing {
                        if model.activity.progress?.waiting != nil {
                            Button("Index Now") { model.indexNow() }
                                .help("Stop waiting for power and read the files now.")
                        }
                        Button("Stop Indexing") { model.cancelIndex() }
                    } else {
                        Button(model.needsReindex ? "Update Index to Apply Changes" : "Update Index Now") { model.startIndex() }
                            .keyboardShortcut(model.needsReindex ? .defaultAction : nil)
                    }
                    Button("Rebuild…") { confirmRebuild = true }
                        .disabled(model.indexing)
                    Spacer()
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
