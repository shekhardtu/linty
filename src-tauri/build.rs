use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    assert!(target_os == "macos", "Linty supports macOS only");
    assert!(
        matches!(target_arch.as_str(), "aarch64" | "x86_64"),
        "Linty supports Apple silicon and Intel Macs only"
    );
    // The Intel slice of a universal app must never link the ARM Swift archive.
    if env::var_os("CARGO_FEATURE_PARAKEET").is_some() && target_arch == "aarch64" {
        build_parakeet_bridge();
    }
    tauri_build::build()
}

/// Compile the Swift bridge in `swift/` (FluidAudio + Parakeet) into a static
/// library and tell rustc how to link it. Requires Xcode 16+ (Swift 6 toolchain)
/// and, on the first build, network access for SwiftPM to fetch FluidAudio.
fn build_parakeet_bridge() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    assert!(
        target_os == "macos",
        "the `parakeet` feature is macOS-only (target_os = {target_os})"
    );

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let package_dir = manifest_dir.join("swift");
    let scratch_dir = PathBuf::from(env::var("OUT_DIR").unwrap()).join("swift-build");

    // CI can supply an archive cached by Swift sources, dependency lockfile,
    // target architecture, toolchain/SDK, and build recipe. Local builds keep
    // using SwiftPM normally. An explicitly supplied but missing archive fails.
    println!("cargo:rerun-if-env-changed=LINTY_PARAKEET_LIB_DIR");
    let prebuilt_dir = env::var_os("LINTY_PARAKEET_LIB_DIR").map(PathBuf::from);

    println!("cargo:rerun-if-changed=swift/Package.swift");
    println!("cargo:rerun-if-changed=swift/Package.resolved");
    println!("cargo:rerun-if-changed=swift/Sources");

    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let swift_arch = match target_arch.as_str() {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        other => panic!("unsupported target arch for the parakeet bridge: {other}"),
    };

    if prebuilt_dir.is_none() {
        let mut cmd = Command::new("swift");
        cmd.arg("build")
            .args(["-c", "release"])
            .arg("--package-path")
            .arg(&package_dir)
            .arg("--scratch-path")
            .arg(&scratch_dir);
        // Only ask SwiftPM to cross-build when the target differs from the host;
        // a plain build keeps the default (and fastest) single-arch layout.
        if swift_arch != host_swift_arch() {
            cmd.args(["--arch", swift_arch]);
        }

        let status = cmd.status().unwrap_or_else(|e| {
            panic!("failed to run `swift build` for the parakeet bridge (is Xcode installed?): {e}")
        });
        assert!(
            status.success(),
            "`swift build` failed for the parakeet bridge"
        );
    }

    let using_prebuilt = prebuilt_dir.is_some();
    let lib_dir = prebuilt_dir.unwrap_or_else(|| {
        find_static_lib(&scratch_dir).unwrap_or_else(|| {
            panic!(
                "libLintyParakeet.a not found under {}",
                scratch_dir.display()
            )
        })
    });
    let archive = lib_dir.join("libLintyParakeet.a");
    assert!(
        archive.is_file(),
        "Swift bridge missing: {}",
        archive.display()
    );
    if using_prebuilt {
        println!("cargo:rerun-if-changed={}", archive.display());
    }

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=LintyParakeet");

    for framework in [
        "Foundation",
        "AVFoundation",
        "CoreML",
        "Accelerate",
        "Metal",
        "MetalPerformanceShaders",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }

    // Swift runtime + C++ stdlib (FluidAudio bundles a small C++ clustering helper).
    if let Some(sdk) = xcrun(&["--show-sdk-path"]) {
        println!("cargo:rustc-link-search=native={sdk}/usr/lib/swift");
    }
    if let Some(swift_bin) = xcrun(&["--find", "swift"]) {
        let toolchain_lib = Path::new(&swift_bin)
            .ancestors()
            .nth(2)
            .map(|usr| usr.join("lib/swift/macosx"));
        if let Some(dir) = toolchain_lib {
            println!("cargo:rustc-link-search=native={}", dir.display());
        }
    }
    println!("cargo:rustc-link-lib=dylib=swiftCore");
    println!("cargo:rustc-link-lib=dylib=c++");
    // Swift objects autolink the rest of the runtime (swift_Concurrency, …) via
    // @rpath; swiftc adds this rpath implicitly, rustc/cc do not. The system
    // runtime in /usr/lib/swift ships with macOS, so nothing is bundled.
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}

fn host_swift_arch() -> &'static str {
    match env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    }
}

fn xcrun(args: &[&str]) -> Option<String> {
    let out = Command::new("xcrun").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// SwiftPM's output layout differs between plain and `--arch` builds; probe
/// the known locations for the archive.
fn find_static_lib(scratch_dir: &Path) -> Option<PathBuf> {
    let candidates = [
        scratch_dir.join("release"),
        scratch_dir.join("arm64-apple-macosx/release"),
        scratch_dir.join("x86_64-apple-macosx/release"),
        scratch_dir.join("apple/Products/Release"),
    ];
    candidates
        .into_iter()
        .find(|dir| dir.join("libLintyParakeet.a").is_file())
}
