#if os(macOS)
import AppKit
import SwiftUI
import ZSearchKit

/// The row of filters under the search field. Each control reads and writes a token of the query
/// (`type:pdf`, `in:~/Documents`, `re:`...), so typing a filter and picking one stay in sync.
struct FilterBar: View {
    @Environment(SearchModel.self) private var model

    struct Option: Hashable {
        let title: String
        let value: String
        init(_ title: String, _ value: String) {
            self.title = title
            self.value = value
        }
    }

    private static let types: [Option] = [
        Option("Documents", "docs"), Option("PDFs", "pdf"), Option("Text and notes", "notes"), Option("Code", "code"),
        Option("Spreadsheets", "sheet"), Option("Presentations", "slides"), Option("Images", "image"),
        Option("Audio", "audio"), Option("Video", "video"), Option("Archives", "archive"), Option("Folders", "folder"),
    ]
    private static let ages: [Option] = [
        Option("Today", "today"), Option("Past week", "week"), Option("Past month", "month"), Option("Past year", "year"),
        Option("Older than a year", ">1y"),
    ]
    private static let sizes: [Option] = [
        Option("Under 100 KB", "<100kb"), Option("Over 1 MB", ">1mb"), Option("Over 10 MB", ">10mb"),
        Option("Over 100 MB", ">100mb"), Option("Over 1 GB", ">1gb"),
    ]

    var body: some View {
        let query = model.query
        HStack(spacing: 6) {
            choiceMenu("Type", icon: "doc", keys: QueryFilters.typeKeys, options: Self.types, anyTitle: "Any Type", query: query)
            ExtensionField()
            folderMenu(query)
            choiceMenu("Modified", icon: "calendar", keys: QueryFilters.modifiedKeys, options: Self.ages, anyTitle: "Any Time", query: query)
            choiceMenu("Size", icon: "internaldrive", keys: QueryFilters.sizeKeys, options: Self.sizes, anyTitle: "Any Size", query: query)
            regexToggle(query)
            Spacer(minLength: 0)
            if QueryFilters.hasFilters(query) || QueryFilters.isRegex(query) {
                Button("Clear Filters") {
                    model.query = QueryFilters.settingRegex(false, in: QueryFilters.clearingFilters(model.query))
                    model.requestSearchFocus()
                }
                .buttonStyle(.link)
                .font(.callout)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private func set(_ keys: [String], _ value: String?) {
        model.query = QueryFilters.setting(keys, to: value, in: model.query)
        model.requestSearchFocus()
    }

    private func choiceMenu(_ title: String, icon: String, keys: [String], options: [Option], anyTitle: String, query: String) -> some View {
        let value = QueryFilters.value(keys, in: query)
        let label: String
        if let value {
            // A value typed by hand that isn't one of the choices shows as written.
            label = options.first { $0.value == value.lowercased() }?.title
                ?? "\(QueryFilters.key(keys, in: query) ?? keys[0]):\(value)"
        } else {
            label = title
        }
        return Menu {
            Button(anyTitle) { set(keys, nil) }
            Divider()
            ForEach(options, id: \.value) { option in
                Button(option.title) { set(keys, option.value) }
            }
        } label: {
            FilterChip(title: label, icon: icon, active: value != nil)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .fixedSize()
        .help("\(title) filter (\(keys[0]):…)")
    }

    private func folderMenu(_ query: String) -> some View {
        let value = QueryFilters.value(QueryFilters.folderKeys, in: query)
        let label = value.map { v in
            let name = (v as NSString).lastPathComponent
            return name.isEmpty || v == "~" ? v : name
        } ?? "Folder"
        return Menu {
            Button("Any Folder") { set(QueryFilters.folderKeys, nil) }
            let roots = model.config?.roots ?? []
            if !roots.isEmpty {
                Divider()
                ForEach(roots, id: \.self) { root in
                    Button(root) { set(QueryFilters.folderKeys, root) }
                }
            }
            Divider()
            Button("Choose Folder…") { chooseFolder() }
        } label: {
            FilterChip(title: label, icon: "folder", active: value != nil)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .fixedSize()
        .help(value.map { "Only in \($0)" } ?? "Only search inside a folder (in:…)")
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        set(QueryFilters.folderKeys, tildePath(url.path))
    }

    private func regexToggle(_ query: String) -> some View {
        let on = QueryFilters.isRegex(query)
        return Button {
            model.query = QueryFilters.settingRegex(!on, in: model.query)
            model.requestSearchFocus()
        } label: {
            FilterChip(title: "Regex", icon: "chevron.left.forwardslash.chevron.right", active: on, showsChevron: false)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .help("Match a regular expression (re:… or /…/)")
    }
}

/// `ext:` as a small text field: "pdf", or "md,txt" for several.
private struct ExtensionField: View {
    @Environment(SearchModel.self) private var model

    var body: some View {
        let value = QueryFilters.value(QueryFilters.extKeys, in: model.query)
        let text = Binding<String>(
            get: { value ?? "" },
            set: { typed in
                let cleaned = typed.filter { !$0.isWhitespace && $0 != "\"" }
                model.query = QueryFilters.setting(QueryFilters.extKeys, to: cleaned.isEmpty ? nil : cleaned, in: model.query)
            }
        )
        HStack(spacing: 4) {
            Text(".")
                .foregroundStyle(value == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.accentColor))
            TextField("ext", text: text)
                .textFieldStyle(.plain)
                .frame(width: 56)
                .onSubmit { model.requestSearchFocus() }
        }
        .font(.callout)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(value == nil ? Color.secondary.opacity(0.1) : Color.accentColor.opacity(0.15)))
        .help("File extension (ext:…), e.g. pdf or md,txt")
    }
}

struct FilterChip: View {
    let title: String
    let icon: String
    let active: Bool
    var showsChevron = true

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .imageScale(.small)
            Text(title)
                .lineLimit(1)
            if showsChevron {
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
            }
        }
        .font(.callout)
        .foregroundStyle(active ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.secondary))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(active ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.1)))
        .contentShape(Capsule())
    }
}
#endif
