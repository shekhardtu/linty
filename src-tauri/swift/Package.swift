// swift-tools-version:6.2
// Swift bridge that exposes FluidAudio's Parakeet models (CoreML / Neural Engine)
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
        // Linty uses ASR/VAD and its own cleanup engine. Disable the bundled
        // NeMo Rust text-normalization engine to avoid a second Rust runtime.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.5", traits: [])
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
    ],
    swiftLanguageModes: [.v5]
)
