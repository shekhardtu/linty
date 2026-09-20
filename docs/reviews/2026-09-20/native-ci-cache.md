# Native CI cache review

The baseline [PR #81 native job](https://github.com/shekhardtu/linty/actions/runs/35476670250/job/105986979799) took 7m 34s. Rust tests and compilation took 2m 57s; building the native application with production assets took 2m 32s; Swift tests took 38s; saving the Rust cache took 39s. The existing dependency cache hit, but discarded workspace incremental artifacts. The two Rust builds could compile the Swift release bridge independently, and Swift tests had no persistent build directory.

The revised checks preserve Rust workspace outputs and incremental state, Cargo downloads, and the Swift test scratch directory. Restore keys allow compatible previous builds to seed changed source/dependency builds; Cargo and Swift still decide which inputs must rebuild. OS, architecture, Rust compiler, and Xcode/Swift/SDK fingerprints separate incompatible caches.

Native checks and release builds share one composite action for the compiled Swift release bridge. That archive has an exact key covering its source, dependency lock, architecture, toolchain, and build recipe, with no fallback. Both Rust build modes link the same verified archive. Swift tests use a separate cached directory so restoring their incremental state cannot overwrite the release archive.

All existing native, production-build, Swift, supervisor, and advisory checks still execute. Main pushes invoke the suite through the release workflow, instead of also starting a duplicate standalone Checks run. A first run seeds the new caches; a repeat of the native job measures the warm-cache result.

The baseline [v0.0.56 release](https://github.com/shekhardtu/linty/actions/runs/35477037039) took 11m 25s. Its signed build job took five minutes, but began only after nearly six minutes of validation. Release builds now run concurrently with checks. A separate publication job requires both jobs to succeed before it tags or publishes anything. A Git bundle transfers the exact built version commit; publication verifies its SHA, parent source SHA, and manifest versions before tagging it.

Use the workflow's `build_only` input to measure a warm release without publishing another version. It still builds, signs, notarizes, and runs checks; it permits rebuilding unchanged release notes but cannot start the publication job. Ordinary releases retain the changed-notes requirement. The target is 5–6 minutes for a warm full release; cold caches, runner queue time, and Apple's notarization service can add time.
