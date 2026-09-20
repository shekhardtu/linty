# Contributing to Linty

Privacy first. Bug reports, documentation, accessibility improvements, and code contributions are welcome. For a larger change, [start a discussion](https://github.com/shekhardtu/linty/discussions) about the intended behavior first.

## Development setup

Use macOS 14+ on Apple Silicon, Xcode 16+ (Swift 6) with its command-line tools selected, stable Rust, Node.js 24+, and Yarn 1.x. Parakeet needs full Xcode; Command Line Tools alone are not sufficient.

```bash
git clone https://github.com/shekhardtu/linty.git
cd linty
yarn install --frozen-lockfile
yarn tauri dev --features local-stt,parakeet
```

The first build compiles both local engines and fetches Swift dependencies. `yarn dev` runs only the frontend on port 1420; native commands require the Tauri app. Vite reloads frontend changes automatically.

See [Development setup](docs/DEV-SETUP.md) for feature flags and release signing. You do not need the maintainer's signing credentials to contribute or run development mode.

## Project structure

- `src/` — React frontend, pages, components, services, and Zustand state.
- `src-tauri/src/` — Rust audio, transcription, storage, and macOS integration.
- `src-tauri/swift/` — Parakeet bridge using FluidAudio.
- `website/` — static landing page and product screenshots.
- `tests/` — frontend unit and browser checks.
- `.github/workflows/` — checks and signed macOS release builds.

## Before submitting a pull request

Run checks relevant to your change:

```bash
yarn test
yarn build
cd src-tauri
cargo fmt --check
cargo test --locked --features local-stt,parakeet
```

For UI changes, include screenshots in both themes and verify keyboard navigation, narrow layouts, and reduced motion. Browser checks are available through `yarn test:ui`, `yarn test:motion`, and `yarn test:usability` with the dev server running.

For permissions, recording, or paste changes, also test a packaged app launched from Finder. Development launches can behave differently under macOS permission checks.

Keep pull requests focused. Explain the problem, resulting behavior, and validation. Use conventional commit titles such as `fix(audio): recover after input disconnects`. Match existing code style and avoid unrelated formatting changes.

## Privacy and security

Use synthetic text and audio in fixtures and screenshots. Do not commit personal transcriptions, API keys, signing keys, or model downloads. Logs must not contain transcription text, dictionary entries, or credentials.

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/shekhardtu/linty/security/advisories/new), as described in [SECURITY.md](SECURITY.md).

## License

Contributions are licensed under the repository's [MIT License](LICENSE). Third-party code and assets must retain their applicable notices.

Dependency changes also require refreshing the bundled notices and reviewing advisory exceptions; see [Security maintenance](docs/SECURITY-MAINTENANCE.md).
