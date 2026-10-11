import Foundation

/// A code editor the app can open a file in, at a line (⌘E). Each is found by its bundle
/// identifier and run through the command-line tool inside its bundle.
public struct EditorApp: Hashable, Sendable, Identifiable {
    public enum Style: Sendable {
        /// `-g file:line` (VS Code and its forks)
        case goTo
        /// `file:line` (Zed, Sublime Text)
        case colon
        /// `-l line file` (Xcode's xed)
        case xed
    }

    public var name: String
    public var bundleID: String
    /// The tool, relative to the app bundle, or absolute.
    public var tool: String
    public var style: Style

    public var id: String { bundleID }

    public static let known: [EditorApp] = [
        EditorApp(name: "Visual Studio Code", bundleID: "com.microsoft.VSCode", tool: "Contents/Resources/app/bin/code", style: .goTo),
        EditorApp(name: "Cursor", bundleID: "com.todesktop.230313mzl4w4u92", tool: "Contents/Resources/app/bin/cursor", style: .goTo),
        EditorApp(name: "Zed", bundleID: "dev.zed.Zed", tool: "Contents/MacOS/cli", style: .colon),
        EditorApp(name: "Sublime Text", bundleID: "com.sublimetext.4", tool: "Contents/SharedSupport/bin/subl", style: .colon),
        EditorApp(name: "Windsurf", bundleID: "com.exafunction.windsurf", tool: "Contents/Resources/app/bin/windsurf", style: .goTo),
        EditorApp(name: "VSCodium", bundleID: "com.vscodium", tool: "Contents/Resources/app/bin/codium", style: .goTo),
        EditorApp(name: "Visual Studio Code - Insiders", bundleID: "com.microsoft.VSCodeInsiders", tool: "Contents/Resources/app/bin/code-insiders", style: .goTo),
        EditorApp(name: "Xcode", bundleID: "com.apple.dt.Xcode", tool: "/usr/bin/xed", style: .xed),
    ]

    /// The tool's path for the app installed at `bundle`.
    public func toolPath(bundle: URL) -> String {
        tool.hasPrefix("/") ? tool : bundle.appendingPathComponent(tool).path
    }

    /// The tool's arguments to open `path`, at `line` when there is one.
    public func arguments(path: String, line: Int?) -> [String] {
        guard let line, line > 0 else { return [path] }
        switch style {
        case .goTo: return ["-g", "\(path):\(line)"]
        case .colon: return ["\(path):\(line)"]
        case .xed: return ["-l", String(line), path]
        }
    }

    /// Whether ⌘E opens this kind of file in the editor: text and code, and folders (as a
    /// project). Documents, media and the like open in their default app instead.
    public static func edits(kind: String, isDir: Bool) -> Bool {
        isDir ? kind == "folder" : ["code", "text", "markdown", "data", "web", "other"].contains(kind)
    }
}
