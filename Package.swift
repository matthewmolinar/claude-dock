// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ClaudeDock",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "ClaudeDock",
            path: "Sources/ClaudeDock",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Carbon"),
            ]
        ),
    ]
)
