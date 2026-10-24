#if os(macOS)
import AppKit
import SwiftUI
import ZSearchKit

/// First-run setup: each step of the first index, with its counts and the time left, and a log.
/// Shown in the main window until `SearchModel.setupComplete`.
struct SetupProgressView: View {
    @Environment(SearchModel.self) private var model

    var body: some View {
        VStack(spacing: 24) {
            Spacer(minLength: 0)
            VStack(spacing: 6) {
                Text("Building the index")
                    .font(.title2.bold())
                if let roots = model.config?.roots, !roots.isEmpty {
                    Text(roots.joined(separator: ", "))
                        .font(.callout.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Text("Search opens when the semantic index is complete. Everything runs on this Mac.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            SetupSteps(activity: model.activity)
            SetupLog(activity: model.activity)
            SetupControls()
            Spacer(minLength: 0)
        }
        .frame(maxWidth: 520)
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private enum StepState {
    case waiting, active, done, failed
}

/// The steps, and how far each has got.
private struct SetupSteps: View {
    @Environment(SearchModel.self) private var model
    let activity: IndexActivity
    @State private var remaining = RemainingTime()
    @State private var secondsLeft: Double?

    var body: some View {
        let p = model.indexing ? activity.progress : nil
        let semanticRuns = model.semantic?.helper != nil && model.config?.content.enabled != false
        VStack(alignment: .leading, spacing: 14) {
            if semanticRuns { download }
            step("Scan folders", state: scanState(p), detail: scanDetail(p), fraction: nil)
            step("Extract text", state: extractState(p), detail: extractDetail(p), fraction: p?.phase == "content" ? p?.fraction : nil)
            if semanticRuns {
                step("Build the semantic index", state: embedState(p), detail: embedDetail(p), fraction: p?.phase == "meaning" ? p?.fraction : nil)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: activity.progress) { _, progress in
            guard let progress, let count = counts(progress) else {
                secondsLeft = nil
                return
            }
            secondsLeft = remaining.update(phase: progress.phase, done: count.done, total: count.total, now: Date().timeIntervalSinceReferenceDate)
        }
    }

    /// What the time left is measured on: files read, then files embedded.
    private func counts(_ p: IndexProgress) -> (done: Int, total: Int)? {
        switch p.phase {
        case "content": return (p.contentDone, p.contentTotal)
        case "meaning": return p.meaning.map { ($0.done, $0.total) }
        default: return nil
        }
    }

    /// Where a run is: 0 scanning, 1 extracting text, 2 embedding.
    private func stage(_ p: IndexProgress?) -> Int? {
        switch p?.phase {
        case nil: return nil
        case "content", "cleanup": return 1
        case "meaning": return 2
        default: return 0
        }
    }

    private var indexedOnce: Bool { model.stats?.lastIndexedAt != nil }

    @ViewBuilder private var download: some View {
        let title = "Granite embedding model"
        if let s = model.semantic, s.model.ready {
            step(title, state: .done, detail: "Installed · \(bytes(s.model.bytes))", fraction: nil)
        } else if model.downloadingModel {
            let d = model.semanticDownload
            step(title, state: .active,
                 detail: d.map { "Downloading \($0.file) · \(bytes($0.received)) of \(bytes($0.total))" } ?? "Starting the download",
                 fraction: d.flatMap { $0.total > 0 ? Double($0.received) / Double($0.total) : nil })
        } else if let error = model.installError {
            step(title, state: .failed, detail: "Download failed: \(error)", fraction: nil)
        } else {
            step(title, state: .waiting, detail: model.semantic.map { "\(bytes($0.model.bytes)) to download" }, fraction: nil)
        }
    }

    private func scanState(_ p: IndexProgress?) -> StepState {
        if stage(p) == 0 { return .active }
        return indexedOnce || stage(p) != nil ? .done : .waiting
    }

    private func scanDetail(_ p: IndexProgress?) -> String? {
        if let p, stage(p) == 0 { return "\(p.scanned.formatted()) items scanned" }
        return model.stats.map { "\($0.files.formatted()) files · \($0.folders.formatted()) folders" }
    }

    private func extractState(_ p: IndexProgress?) -> StepState {
        if stage(p) == 1 { return .active }
        return indexedOnce || (stage(p) ?? 0) > 1 ? .done : .waiting
    }

    private func extractDetail(_ p: IndexProgress?) -> String? {
        guard let p, stage(p) == 1 else { return model.stats.map { "\($0.withContent.formatted()) files with text" } }
        if let waiting = p.waiting { return "Paused: \(waiting)" }
        if p.phase == "cleanup" { return "Removing deleted files from the index" }
        var parts = ["\(p.contentDone.formatted()) of \(p.contentTotal.formatted()) files to read in this pass", "\(bytes(p.contentBytes)) of text"]
        if p.contentErrors > 0 { parts.append("\(p.contentErrors.formatted()) unreadable") }
        return parts.joined(separator: " · ") + timeLeft
    }

    private func embedState(_ p: IndexProgress?) -> StepState {
        if stage(p) == 2 { return .active }
        if let c = model.stats?.semantic, c.pending == 0 { return .done }
        return .waiting
    }

    private func embedDetail(_ p: IndexProgress?) -> String? {
        if let p, stage(p) == 2 {
            if let waiting = p.waiting { return "Paused: \(waiting)" }
            guard let m = p.meaning else { return nil }
            return "\(m.done.formatted()) of \(m.total.formatted()) files · \(m.embedded.formatted()) passages embedded, \(m.reused.formatted()) reused" + timeLeft
        }
        guard let c = model.stats?.semantic else { return nil }
        return c.pending == 0 ? "\(c.files.formatted()) files embedded" : "\(c.current.formatted()) of \(c.files.formatted()) files embedded"
    }

    private var timeLeft: String {
        secondsLeft.map { " · " + RemainingTime.text($0).lowercased() } ?? ""
    }

    private func bytes(_ n: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }

    private func step(_ title: String, state: StepState, detail: String?, fraction: Double?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Group {
                switch state {
                case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                case .active: Image(systemName: "circle.dotted").foregroundStyle(.tint)
                case .failed: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
                case .waiting: Image(systemName: "circle").foregroundStyle(.tertiary)
                }
            }
            .font(.title3)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(state == .waiting ? Color.secondary : Color.primary)
                if state == .active {
                    ProgressView(value: fraction)
                        .progressViewStyle(.linear)
                }
                if let detail {
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(state == .failed ? Color.orange : Color.secondary)
                        .monospacedDigit()
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
            }
        }
    }
}

/// The indexing log (`IndexLog`), folded away until opened.
private struct SetupLog: View {
    let activity: IndexActivity
    @AppStorage("setupLogExpanded") private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .trailing, spacing: 6) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 1) {
                            ForEach(activity.log.lines) { line in
                                Text("\(IndexLog.clock(line.time))  \(line.text)")
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .id(line.id)
                            }
                        }
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .padding(8)
                    }
                    .frame(height: 180)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
                    .onChange(of: activity.log.lines.last?.id) { _, id in
                        if let id { proxy.scrollTo(id, anchor: .bottom) }
                    }
                    .onAppear {
                        if let id = activity.log.lines.last?.id { proxy.scrollTo(id, anchor: .bottom) }
                    }
                }
                Button("Copy Log") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(activity.log.text(), forType: .string)
                }
                .controlSize(.small)
                .disabled(activity.log.lines.isEmpty)
            }
            .padding(.top, 6)
        } label: {
            Text("Log")
                .font(.callout)
        }
    }
}

/// What can be done while setup runs: carry on when it stopped, pause, change the folders.
private struct SetupControls: View {
    @Environment(SearchModel.self) private var model

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                if model.installError != nil, !model.downloadingModel {
                    Button("Try the Download Again") { model.installSemantic() }
                        .keyboardShortcut(.defaultAction)
                } else if model.indexing {
                    if model.activity.progress?.waiting != nil {
                        Button("Continue Now") { model.indexNow() }
                            .keyboardShortcut(.defaultAction)
                    }
                    Button("Pause") { model.cancelIndex() }
                } else if model.stats != nil, !model.downloadingModel {
                    Button("Continue Setup") { model.startIndex() }
                        .keyboardShortcut(.defaultAction)
                }
                Button("Change Folders…") { model.showSetup = true }
            }
            if let notice = model.notice {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
        }
    }
}
#endif
