#if os(macOS)
import AppKit
import Quartz
import SwiftUI

/// The search, results and preview in a launcher-style panel: what the global shortcut opens.
/// It floats over other apps, full-screen ones included, on the screen with the pointer, and
/// takes the keyboard without bringing the rest of zsearch forward. Esc, a click elsewhere or
/// opening a file puts it away.
@MainActor
final class QuickPanel: NSObject, NSWindowDelegate {
    static let shared = QuickPanel()

    private var panel: FloatingPanel?

    var isVisible: Bool { panel?.isVisible == true }
    var isKey: Bool { panel?.isKeyWindow == true }

    /// Show the panel, or put it away when it is already in front.
    func toggle(_ model: SearchModel) {
        if isVisible, isKey { hide() } else { show(model) }
    }

    func show(_ model: SearchModel) {
        // Choosing what to index needs the main window.
        if model.firstRun || model.showSetup || model.engineFailure != nil { return model.showMainWindow() }
        let panel = self.panel ?? make(model)
        self.panel = panel
        if !panel.isVisible { place(panel) }
        panel.makeKeyAndOrderFront(nil)
        model.requestSearchFocus()
    }

    func hide() {
        panel?.orderOut(nil)
    }

    /// A file was opened or revealed from the panel: its job is done.
    func fileOpened() {
        if isKey { hide() }
    }

    private func make(_ model: SearchModel) -> FloatingPanel {
        let panel = FloatingPanel(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 540),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .utilityWindow
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.delegate = self
        let root = ContentView(isPanel: true)
            .environment(model)
            .environment(\.dismissPanel, DismissPanel { [weak self] in self?.hide() })
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        let hosting = NSHostingView(rootView: root)
        // The panel's size is set here, not by the content.
        hosting.sizingOptions = []
        panel.contentView = hosting
        return panel
    }

    /// Centered on the screen with the pointer, a little above the middle, like Spotlight.
    private func place(_ panel: NSPanel) {
        let mouse = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        let width = min(900, visible.width - 40)
        let height = min(540, visible.height - 40)
        let frame = NSRect(x: visible.midX - width / 2, y: visible.maxY - height - (visible.height - height) * 0.3, width: width, height: height)
        panel.setFrame(frame, display: false)
    }

    func windowDidResignKey(_ notification: Notification) {
        // A click in another app puts the panel away; Quick Look opening over it does not.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isVisible, !self.isKey else { return }
            if NSApp.keyWindow is QLPreviewPanel { return }
            self.hide()
        }
    }
}

/// A borderless panel that can still take the keyboard.
final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        orderOut(nil)
    }
}

/// Puts the panel away; set only inside the panel.
struct DismissPanel {
    let action: () -> Void
    func callAsFunction() { action() }
}

private struct DismissPanelKey: EnvironmentKey {
    static let defaultValue: DismissPanel? = nil
}

extension EnvironmentValues {
    var dismissPanel: DismissPanel? {
        get { self[DismissPanelKey.self] }
        set { self[DismissPanelKey.self] = newValue }
    }
}

/// The app's keyboard shortcuts, for the panel: it takes the keyboard while another app stays
/// active, and that app's menus, not zsearch's, get the key equivalents.
struct PanelShortcuts: View {
    @Environment(SearchModel.self) private var model

    var body: some View {
        ZStack {
            buttons
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    @ViewBuilder private var buttons: some View {
        Group {
            Button("Open in Editor") { model.openSelectedInEditor() }.keyboardShortcut("e")
            Button("Quick Look") { model.toggleQuickLook() }.keyboardShortcut("y")
            Button("Next Match") { model.jumpToMatch(by: 1) }.keyboardShortcut("g")
            Button("Previous Match") { model.jumpToMatch(by: -1) }.keyboardShortcut("g", modifiers: [.command, .shift])
            Button("Show in Finder") { model.revealSelected() }.keyboardShortcut("r", modifiers: [.command, .shift])
            Button("Copy Path") { model.copySelectedPath() }.keyboardShortcut("c", modifiers: [.command, .shift])
        }
        Group {
            Button("Find") { model.mode = .find }.keyboardShortcut("1")
            Button("Fuzzy") { model.mode = .fuzzy }.keyboardShortcut("2")
            Button("Next Result") { model.moveSelection(by: 1) }.keyboardShortcut("j")
            Button("Previous Result") { model.moveSelection(by: -1) }.keyboardShortcut("k")
            Button("Open Main Window") { model.showMainWindow() }.keyboardShortcut("o", modifiers: [.command, .shift])
        }
    }
}
#endif
