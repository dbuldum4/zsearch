#if os(macOS)
import SwiftUI
import ZSearchKit

/// First-run setup: what zsearch does before search opens, step by step, with the time left.
/// Shown in the main window until `SearchModel.setupComplete`.
struct SetupProgressView: View {
    @Environment(SearchModel.self) private var model

    var body: some View {
        VStack(spacing: 28) {
            Spacer(minLength: 0)
            VStack(spacing: 10) {
                Image(systemName: "sparkle.magnifyingglass")
                    .font(.system(size: 44))
                    .foregroundStyle(.tint)
                Text("Getting zsearch ready")
                    .font(.title.bold())
                Text("zsearch is reading your files so you can find them by describing what they're about. Search opens as soon as this is done. Everything stays on this Mac.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            SetupSteps(activity: model.activity)
            SetupControls()
            Spacer(minLength: 0)
        }
        .frame(maxWidth: 460)
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private enum StepState {
    case waiting, active, done, failed
}

/// The steps, and how far each has got. The only part of setup that observes indexing progress.
private struct SetupSteps: View {
    @Environment(SearchModel.self) private var model
    let activity: IndexActivity
    @State private var remaining = RemainingTime()
    @State private var secondsLeft: Double?

    var body: some View {
        let p = model.indexing ? activity.progress : nil
        let semanticRuns = model.semantic?.helper != nil && model.config?.content.enabled != false
        VStack(alignment: .leading, spacing: 16) {
            if semanticRuns { download }
            step("Find your files", state: findState(p), detail: findDetail(p), fraction: nil)
            step("Read what's inside them", state: readState(p), detail: readDetail(p), fraction: p?.phase == "content" ? p?.fraction : nil)
            if semanticRuns {
                step("Learn what each one is about", state: learnState(p), detail: learnDetail(p), fraction: p?.phase == "meaning" ? p?.fraction : nil)
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

    /// What the time left is measured on: files read, then files learned.
    private func counts(_ p: IndexProgress) -> (done: Int, total: Int)? {
        switch p.phase {
        case "content": return (p.contentDone, p.contentTotal)
        case "meaning": return p.meaning.map { ($0.done, $0.total) }
        default: return nil
        }
    }

    /// Where a run is: 0 finding files, 1 reading them, 2 learning them.
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
        if model.semantic?.model.ready == true {
            step("Download the language model", state: .done, detail: nil, fraction: nil)
        } else if model.downloadingModel {
            let d = model.semanticDownload
            step("Download the language model", state: .active,
                 detail: d.map { "\(bytes($0.received)) of \(bytes($0.total))" } ?? "Starting the download…",
                 fraction: d.flatMap { $0.total > 0 ? Double($0.received) / Double($0.total) : nil })
        } else if let error = model.installError {
            step("Download the language model", state: .failed, detail: error, fraction: nil)
        } else {
            step("Download the language model", state: .waiting, detail: model.semantic.map { bytes($0.model.bytes) }, fraction: nil)
        }
    }

    private func findState(_ p: IndexProgress?) -> StepState {
        if stage(p) == 0 { return .active }
        return indexedOnce || stage(p) != nil ? .done : .waiting
    }

    private func findDetail(_ p: IndexProgress?) -> String? {
        if let p, stage(p) == 0 { return "\(p.scanned.formatted()) found" }
        return model.stats.map { "\($0.files.formatted()) files" }
    }

    private func readState(_ p: IndexProgress?) -> StepState {
        if stage(p) == 1 { return .active }
        return indexedOnce || (stage(p) ?? 0) > 1 ? .done : .waiting
    }

    private func readDetail(_ p: IndexProgress?) -> String? {
        guard let p, stage(p) == 1 else { return nil }
        if let waiting = p.waiting { return "Paused: \(waiting)" }
        if p.phase == "cleanup" { return "Tidying up…" }
        return "\(p.contentDone.formatted()) of \(p.contentTotal.formatted())" + timeLeft
    }

    private func learnState(_ p: IndexProgress?) -> StepState {
        if stage(p) == 2 { return .active }
        if let c = model.stats?.semantic, c.pending == 0 { return .done }
        return .waiting
    }

    private func learnDetail(_ p: IndexProgress?) -> String? {
        if let p, stage(p) == 2 {
            if let waiting = p.waiting { return "Paused: \(waiting)" }
            guard let m = p.meaning else { return nil }
            return "\(m.done.formatted()) of \(m.total.formatted())" + timeLeft
        }
        guard let c = model.stats?.semantic, c.pending > 0 else { return nil }
        return "\(c.current.formatted()) of \(c.files.formatted()) files"
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
                }
            }
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
