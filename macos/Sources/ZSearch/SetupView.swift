#if os(macOS)
import AppKit
import SwiftUI
import ZSearchKit

/// Choose what to index. Shown on first launch and from File › Choose Folders….
struct SetupView: View {
    @EnvironmentObject private var model: SearchModel
    let inSheet: Bool

    private enum Choice: Hashable {
        case documents, home, custom
    }

    private static let documentRoots = ["~/Documents", "~/Downloads"]

    @State private var choice: Choice = .documents
    @State private var folders: [String] = []
    @State private var readContents = true

    private var roots: [String] {
        switch choice {
        case .documents: return Self.documentRoots
        case .home: return ["~"]
        case .custom: return folders
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("What should zsearch index?")
                .font(.title2.bold())
            Picker("Index", selection: $choice) {
                Text("Documents and Downloads").tag(Choice.documents)
                Text("My whole home folder").tag(Choice.home)
                Text("Folders I choose").tag(Choice.custom)
            }
            .pickerStyle(.radioGroup)
            .labelsHidden()
            if choice == .custom {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(folders, id: \.self) { folder in
                        HStack {
                            Text(folder)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer()
                            Button {
                                folders.removeAll { $0 == folder }
                            } label: {
                                Image(systemName: "minus.circle")
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                    Button("Add Folder…", action: addFolders)
                }
                .padding(.leading, 20)
            }
            Toggle("Read the text inside files (PDF, Office, code, …)", isOn: $readContents)
            Text("macOS may ask to let zsearch read your Documents and Downloads folders. The index stays on this Mac.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                if inSheet, !model.firstRun {
                    Button("Cancel") { model.showSetup = false }
                        .keyboardShortcut(.cancelAction)
                }
                Button("Start Indexing") { model.applySetup(roots: roots, readContents: readContents) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(roots.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear(perform: load)
    }

    private func load() {
        guard let config = model.config else { return }
        readContents = config.content.enabled
        if config.roots == Self.documentRoots {
            choice = .documents
        } else if config.roots == ["~"] {
            choice = .home
        } else {
            choice = .custom
            folders = config.roots
        }
    }

    private func addFolders() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Add"
        guard panel.runModal() == .OK else { return }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for url in panel.urls {
            var path = url.path
            if path == home {
                path = "~"
            } else if path.hasPrefix(home + "/") {
                path = "~" + path.dropFirst(home.count)
            }
            if !folders.contains(path) { folders.append(path) }
        }
    }
}
#endif
