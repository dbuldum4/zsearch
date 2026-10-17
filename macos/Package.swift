// swift-tools-version:5.9
import PackageDescription

// ZSearchKit (the protocol, process handling and text helpers) builds and tests on Linux and macOS.
// ZSearch (the SwiftUI app), OCR and transcription helpers only build on macOS; on Linux they
// compile to stubs.
let package = Package(
    name: "ZSearch",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ZSearch", targets: ["ZSearch"]),
        .executable(name: "zsearch-ocr", targets: ["ZSearchOCR"]),
        .executable(name: "zsearch-transcribe", targets: ["ZSearchTranscribe"]),
        .library(name: "ZSearchKit", targets: ["ZSearchKit"]),
    ],
    targets: [
        .target(name: "ZSearchKit"),
        .executableTarget(name: "ZSearch", dependencies: ["ZSearchKit"]),
        .executableTarget(name: "ZSearchOCR"),
        .executableTarget(name: "ZSearchTranscribe"),
        .testTarget(name: "ZSearchKitTests", dependencies: ["ZSearchKit"], resources: [.copy("Fixtures")]),
    ]
)
