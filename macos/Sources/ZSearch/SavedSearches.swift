#if os(macOS)
import AppKit
import SwiftUI
import ZSearchKit

/// The menu next to the search field: save the search, and run a saved or recent one.
struct SearchesMenu: View {
    @Environment(SearchModel.self) private var model

    var body: some View {
        let searches = model.searches
        let recent = model.recentSearchesShown
        let current = SavedSearches.matching(query: model.query, mode: model.mode, in: searches.saved)
        Menu {
            Button("Save Search…") { model.promptSaveSearch() }
                .disabled(model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if !searches.saved.isEmpty {
                Section("Saved Searches") {
                    ForEach(searches.saved) { saved in
                        Button(saved.name) { model.restore(query: saved.query, mode: saved.mode) }
                    }
                }
            }
            if !recent.isEmpty {
                Section("Recent Searches") {
                    ForEach(recent.prefix(12)) { entry in
                        Button(SavedSearches.menuTitle(query: entry.query, mode: entry.mode, showsMode: !Edition.semanticOnly)) {
                            model.restore(query: entry.query, mode: entry.mode)
                        }
                    }
                }
            }
            Divider()
            Button("Manage Saved Searches…") { model.manageSearches() }
                .disabled(searches.saved.isEmpty)
            Button("Clear Recent Searches") { model.clearRecentSearches() }
                .disabled(searches.recent.isEmpty)
        } label: {
            Image(systemName: current == nil ? "bookmark" : "bookmark.fill")
                .foregroundStyle(current == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.accentColor))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(current.map { "Saved as “\($0.name)”" } ?? "Save this search, or run a saved or recent one")
        // The terminal app and the command line change them too.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await model.refreshSearches() }
        }
    }
}

/// The prompt for a new saved search's name, and the list of saved searches. Only the main
/// window shows them.
struct SavedSearchDialogs: ViewModifier {
    @Environment(SearchModel.self) private var model
    let enabled: Bool
    @State private var name = ""

    func body(content: Content) -> some View {
        @Bindable var model = model
        let replacing = SavedSearches.existing(named: name, in: model.searches.saved)
        content
            .alert("Save Search", isPresented: enabled ? $model.savingSearch : .constant(false)) {
                TextField("Name", text: $name)
                Button(replacing == nil ? "Save" : "Replace") { model.saveSearch(named: name) }
                    .disabled(SavedSearches.problem(with: name, in: model.searches.saved) != nil)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(replacing.map { "Replaces the saved search “\($0.name)”." } ?? "Saves the query with its filters, sorting and mode.")
            }
            .onChange(of: model.savingSearch) { _, saving in
                if saving { name = SavedSearches.suggestedName(for: model.query) }
            }
            .sheet(isPresented: enabled ? $model.managingSearches : .constant(false)) {
                ManageSearchesView()
                    .environment(model)
            }
    }
}

struct ManageSearchesView: View {
    @Environment(SearchModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var renaming: SavedSearch?
    @State private var newName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Saved Searches")
                .font(.headline)
                .padding()
            List(model.searches.saved) { saved in
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(saved.name)
                            .fontWeight(.medium)
                            .lineLimit(1)
                        Text(SavedSearches.menuTitle(query: saved.query, mode: saved.mode, showsMode: !Edition.semanticOnly))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 12)
                    Button("Run") {
                        model.restore(query: saved.query, mode: saved.mode)
                        dismiss()
                    }
                    Button("Rename…") {
                        newName = saved.name
                        renaming = saved
                    }
                    Button(role: .destructive) {
                        model.deleteSearch(saved)
                    } label: {
                        Image(systemName: "trash")
                    }
                    .help("Delete “\(saved.name)”")
                }
                .buttonStyle(.borderless)
                .padding(.vertical, 2)
            }
            .overlay {
                if model.searches.saved.isEmpty {
                    Text("No saved searches")
                        .foregroundStyle(.secondary)
                }
            }
            Divider()
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding()
        }
        .frame(width: 540, height: 380)
        .alert("Rename Saved Search", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Rename") {
                if let renaming { model.renameSearch(renaming, to: newName) }
            }
            .disabled(renaming.map { SavedSearches.problem(with: newName, in: model.searches.saved, renaming: $0) != nil } ?? true)
            Button("Cancel", role: .cancel) {}
        }
    }
}
#endif
