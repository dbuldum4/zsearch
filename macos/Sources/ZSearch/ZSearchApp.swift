#if os(macOS)
import AppKit
import SwiftUI
import ZSearchKit

@main
struct ZSearchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = SearchModel()
    @AppStorage(AppSettings.showMenuBarItem) private var showMenuBarItem = true

    var body: some Scene {
        Window("zsearch", id: "main") {
            ContentView()
                .environment(model)
                .frame(minWidth: 720, minHeight: 420)
                .onAppear {
                    delegate.model = model
                    model.start()
                }
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    model.stop()
                }
        }
        .defaultSize(width: 1100, height: 680)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Update Index") { model.startIndex() }
                    .keyboardShortcut("r")
                    .disabled(model.indexing)
                Button("Stop Indexing") { model.cancelIndex() }
                    .keyboardShortcut(".")
                    .disabled(!model.indexing)
                Button("Choose Folders…") { model.showSetup = true }
                    .keyboardShortcut("i", modifiers: [.command, .shift])
            }
            CommandGroup(after: .pasteboard) {
                Button("Copy Path") { model.copySelectedPath() }
                    .keyboardShortcut("c", modifiers: [.command, .shift])
                    .disabled(model.selectedHit == nil)
                Button("Show in Finder") { model.revealSelected() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                    .disabled(model.selectedHit == nil)
            }
            CommandMenu("Search") {
                Button("Find in Names and Contents") { model.mode = .find; model.requestSearchFocus() }
                    .keyboardShortcut("1")
                Button("Fuzzy Names") { model.mode = .fuzzy; model.requestSearchFocus() }
                    .keyboardShortcut("2")
                Divider()
                Button("Search Field") { model.requestSearchFocus() }
                    .keyboardShortcut("l")
                Button("Next Result") { model.moveSelection(by: 1) }
                    .keyboardShortcut("j")
                Button("Previous Result") { model.moveSelection(by: -1) }
                    .keyboardShortcut("k")
            }
        }

        Settings {
            SettingsView()
                .environment(model)
        }

        MenuBarExtra(isInserted: $showMenuBarItem) {
            MenuBarMenu()
                .environment(model)
        } label: {
            Image(systemName: model.indexing ? "arrow.triangle.2.circlepath" : "magnifyingglass")
        }
    }
}

/// The menu under the menu bar icon.
struct MenuBarMenu: View {
    @Environment(SearchModel.self) private var model

    var body: some View {
        Button("Open zsearch") { model.showMainWindow() }
        Divider()
        if model.indexing {
            Text("Updating the index…")
            Button("Stop Indexing") { model.cancelIndex() }
        } else {
            if let s = model.stats {
                Text("\(s.files.formatted()) files indexed")
            }
            Button("Update Index") { model.startIndex() }
        }
        Divider()
        SettingsLink {
            Text("Settings…")
        }
        Button("Quit zsearch") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var model: SearchModel?
    private var hotKey: HotKey?
    private var hotKeyChoice: HotKeyChoice?
    private var defaultsObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Needed when started with `swift run` (no app bundle); harmless otherwise.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        updateHotKey()
        defaultsObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateHotKey() }
        }
    }

    /// With the menu bar item on, closing the window keeps zsearch running (and its hotkey working).
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        !(UserDefaults.standard.object(forKey: AppSettings.showMenuBarItem) as? Bool ?? true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { model?.showMainWindow() }
        return true
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        let update = NSMenuItem(title: model?.indexing == true ? "Stop Indexing" : "Update Index", action: #selector(toggleIndexing), keyEquivalent: "")
        update.target = self
        menu.addItem(update)
        return menu
    }

    @objc private func toggleIndexing() {
        guard let model else { return }
        if model.indexing { model.cancelIndex() } else { model.startIndex() }
    }

    private func updateHotKey() {
        let choice = HotKeyChoice(rawValue: UserDefaults.standard.string(forKey: AppSettings.hotKey) ?? "") ?? .optionSpace
        guard choice != hotKeyChoice else { return }
        hotKeyChoice = choice
        hotKey = nil
        hotKey = HotKey(choice) { [weak self] in
            MainActor.assumeIsolated { self?.toggleMainWindow() }
        }
    }

    /// The hotkey shows zsearch, or hides it when it is already in front.
    private func toggleMainWindow() {
        if NSApp.isActive, let key = NSApp.keyWindow, key.identifier?.rawValue.hasPrefix("main") == true {
            NSApp.hide(nil)
        } else {
            model?.showMainWindow()
        }
    }
}

#else

@main
enum ZSearchApp {
    static func main() {
        print("The zsearch app needs macOS. On Linux, use the terminal app: zsearch")
    }
}

#endif
