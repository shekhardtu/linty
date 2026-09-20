// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "LintyVadBench",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.14.8"),
        .package(path: "../../../src-tauri/swift")
    ],
    targets: [
        .executableTarget(
            name: "LintyVadBench",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
                .product(name: "LintyParakeet", package: "swift")
            ]
        )
    ]
)
