// swift-tools-version:5.10
// Swift bridge that exposes FluidAudio's Parakeet TDT v3 (CoreML / Neural Engine)
// to Rust through a tiny C ABI. Built by src-tauri/build.rs when the `parakeet`
// Cargo feature is enabled; the resulting static library is linked into linty.
import PackageDescription

let package = Package(
    name: "LintyParakeet",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "LintyParakeet",
            type: .static,
            targets: ["LintyParakeet"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.14.8")
    ],
    targets: [
        .target(
            name: "LintyParakeet",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ],
            path: "Sources/LintyParakeet"
        ),
        .testTarget(name: "LintyParakeetTests", dependencies: ["LintyParakeet"])
    ]
)
