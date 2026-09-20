The macOS release runs the same required checks as a pull request before it can sign or publish. These checks include a native application build with production frontend assets, which catches JavaScript/Rust Tauri version mismatches and packaging configuration errors that unit tests cannot. CI creates a version commit and release tag from the tested source; it does not push version bumps to protected main. The version advances past both the source version and existing release tags. A failed upload can be retried from the retained release artifacts using the existing publishing script.

JavaScript dependencies are checked with `yarn audit`. `python3 scripts/check-rust-advisories.py` checks the locked Apple Silicon macOS feature graph against OSV. Any exceptions in `security/rust-advisories.json` name the exact package version, advisory IDs, reason, and expiry. New versions or advisories need a new review. Current exceptions cover upstream maintenance notices, a build-only legacy rand dependency, and a Tauri issue in Windows/Android code that this app does not ship. Supporting another platform requires a fresh review.

Model commands accept backend catalog IDs, reject symbolic links, and never accept a renderer-supplied download URL. The Whisper artifact has a pinned revision, size, and SHA-256. Capsule permissions permit its overlay controls, theme reader, and events; storage, model management, updater, and restart commands belong to the main window. Production CSP restricts scripts to bundled assets and network access to IPC.

Third-party notices and the component inventory are bundled under `Contents/Resources/licenses/` in the macOS app. Model attribution is in `src-tauri/licenses/MODELS.md`. After dependency changes, run:

```sh
yarn install --frozen-lockfile
cargo fetch --locked --manifest-path src-tauri/Cargo.toml
swift package resolve --package-path src-tauri/swift
python3 scripts/third-party-notices.py
python3 scripts/third-party-notices.py --check
```

Generation reads installed package notices and uses `gh` to retrieve omitted workspace notices at recorded upstream commits. A few legacy MIT crates omit license files even upstream; their notices explicitly identify the metadata declaration, authors, available copyright headers, and standard MIT terms. The inventory is conservative and includes native build dependencies. CI checks its lockfile fingerprints and output checksum without needing network access for license collection.

The Rust and browser tests use synthetic data. Native permission prompts, real clipboard providers, and target-app paste still need acceptance testing on an installed app launched from Finder. Optional S1 cleanup remains disabled by default; its documented semantic-quality limitations remain after the filler-only fix.
