#if os(macOS)
import AppKit
import SwiftUI
import ZSearchKit

@main
struct ZSearchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = SearchModel()

    var body: some Scene {
        Window("zsearch", id: "main") {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 720, minHeight: 420)
                .onAppear { model.start() }
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
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Needed when started with `swift run` (no app bundle); harmless otherwise.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
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
