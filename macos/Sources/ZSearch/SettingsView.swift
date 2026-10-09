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
}

private struct GeneralSettings: View {
    @Environment(SearchModel.self) private var model
    @AppStorage(AppSettings.showMenuBarItem) private var showMenuBarItem = true
    @AppStorage(AppSettings.hotKey) private var hotKey = HotKeyChoice.optionSpace.rawValue
    @State private var openAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginError: String?

    var body: some View {
        Form {
            Picker("Search mode at start", selection: defaultMode) {
                Text("Find (exact text, /regex/)").tag(Mode.find)
                Text("Fuzzy (forgiving names)").tag(Mode.fuzzy)
            }
            Picker("Shortcut to show zsearch", selection: $hotKey) {
                ForEach(HotKeyChoice.allCases) { Text($0.label).tag($0.rawValue) }
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

    private var defaultMode: Binding<Mode> {
        Binding(
            get: { Mode(rawValue: model.config?.defaultMode ?? "find") ?? .find },
            set: { model.updateConfig(ConfigPatch(defaultMode: $0.rawValue), reindex: false) }
        )
    }

    private func setOpenAtLogin(_ on: Bool) {
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
                Toggle("Include hidden files and folders", isOn: flag(\.includeHidden) { ConfigPatch(includeHidden: $0) })
                Toggle("Skip what .gitignore files exclude", isOn: flag(\.respectGitignore) { ConfigPatch(respectGitignore: $0) })
                Toggle("Follow symbolic links to folders", isOn: flag(\.followSymlinks) { ConfigPatch(followSymlinks: $0) })
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
                Picker("Update the index", selection: refresh) {
                    Text("Only when I ask").tag(0.0)
                    Text("Every 15 minutes").tag(15.0)
                    Text("Every hour").tag(60.0)
                    Text("Every 4 hours").tag(240.0)
                    Text("Once a day").tag(1440.0)
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

    private var refresh: Binding<Double> {
        Binding(
            get: { model.config?.autoRefreshMinutes ?? 60 },
            set: { model.updateConfig(ConfigPatch(autoRefreshMinutes: $0), reindex: false) }
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
