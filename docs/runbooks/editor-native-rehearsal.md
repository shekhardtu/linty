# Isolated selected-text editing rehearsal

This opt-in rehearsal checks real macOS Accessibility replacement and guarded Undo against a synthetic background AppKit field. It never activates or writes into the customer’s apps, sends keyboard events, uses the clipboard, or records microphone audio. It is separate from the automated browser/unit suite.

Prepare the concrete test app first:

```sh
yarn test:editor-native --prepare
```

Preparation builds the Rust library test executable with `local-stt`, compiles the synthetic Swift fixture and a small native C launcher, ad-hoc signs each executable and the app, and verifies the bundle signature. It does **not** launch the app or request permission. To reuse an already-built library test executable and avoid Cargo:

```sh
yarn test:editor-native --prepare --test-binary /absolute/path/to/linty_lib-test-executable
```

Reusing a binary verifies that it contains the exact test, but the caller must ensure it was built from the intended source revision. The preparation manifest records source/artifact hashes and whether a binary was reused.

The stable, private location is `~/Library/Caches/linty/editor-native.noindex/Linty Editor Test.app`; its identifier is `ai.linty.editor-test`. `prepared.json` sits beside the bundle. Prepare again after changing the test sources or binary. A rebuilt ad-hoc app may require renewed macOS authorization.

After preparation, explicitly run:

```sh
yarn test:editor-native --run
```

The script launches the prepared app through LaunchServices. Only this explicit run may request Accessibility access for **Linty Editor Test**: the app needs it to inspect and modify its own out-of-process synthetic text fixture. The native launcher stays alive while the one selected Rust test runs. No permission is changed automatically; no TCC reset or toggle is performed. If permission is unavailable after two minutes, the test stops without running.

The exact test is `corrections::accessibility::tests::native_selected_edit_rejects_stale_targets_and_preserves_surroundings`. It checks changed-document and changed-selection rejection, UTF-16 boundaries with an emoji, preservation of surrounding text, one-shot acceptance, and guarded Undo. Passing requires both a successful native launcher result and **one test passed, zero failed** in the captured test output. Accessibility being granted alone does not count as a pass.

Each attempt writes `stdout.log`, `stderr.log`, and `result.json` in a private timestamped `run-*` directory beside the app. Failure remains failure; the script never substitutes browser or pure-unit results for native evidence.
