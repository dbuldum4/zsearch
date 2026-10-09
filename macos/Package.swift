// swift-tools-version:5.9
import PackageDescription

// ZSearchKit (the protocol, process handling and text helpers) builds and tests on Linux and macOS.
// ZSearch (the SwiftUI app) only builds on macOS; on Linux it compiles to a stub.
let package = Package(
    name: "ZSearch",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ZSearch", targets: ["ZSearch"]),
        .library(name: "ZSearchKit", targets: ["ZSearchKit"]),
    ],
    targets: [
        .target(name: "ZSearchKit"),
        .executableTarget(name: "ZSearch", dependencies: ["ZSearchKit"]),
        .testTarget(name: "ZSearchKitTests", dependencies: ["ZSearchKit"], resources: [.copy("Fixtures")]),
    ]
)
