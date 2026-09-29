# Spotlight, installation, and update safety

Investigated on macOS on 2026-09-30.

## Cause

The two search results were two physical bundles with the same identifier and
version: `/Applications/Linty.app` and the release cache's
`bundle/macos/Linty.app`. “Applications” and “macos” were their parent folders.
The latter was a build product, not a second version installed by the updater.
Removing the file alone initially left a stale visible Spotlight result.

Apple describes Spotlight as a filesystem index of apps and other content,
not an inventory restricted to Applications. Apple also documents `.noindex`
paths as excluded from its index:

- [Apple: Spotlight indexing](https://support.apple.com/en-gb/102321)
- [Apple: locating debug symbols and excluded paths](https://developer.apple.com/documentation/xcode/locating-a-missing-debug-symbol-file)

## Established installation pattern

- [Tauri's DMG guidance](https://v2.tauri.app/distribute/dmg/) uses a regular
  application bundle and an Applications shortcut for drag-to-install.
- [Sparkle's integration guidance](https://sparkle-project.org/documentation/)
  recommends a signed, notarized DMG with an Applications symlink, signed update
  archives, and preserving the app bundle structure.
- [Electron's macOS updater](https://www.electronjs.org/docs/latest/api/auto-updater)
  delegates installation to Squirrel.Mac and requires code signing. It warns
  against issuing duplicate update requests that trigger duplicate downloads.

Linty keeps the existing Tauri updater instead of introducing another installer
or a cleanup daemon. The pinned `tauri-plugin-updater 2.12.0` implementation
extracts to a temporary directory, moves the existing app to a temporary backup,
and replaces the app at the path derived from its running executable. The
temporary directory handles clean up at the end of installation. Existing
download signature checks, update serialization, and waiting for dictation to be
idle remain in place. Linty's single-instance plugin already focuses the running
app on a second launch.

## Prevention

1. Local release output uses `cache/target.noindex`. Existing compilation caches
   migrate without deletion; a legacy symlink preserves Cargo's absolute paths.
   Standalone builds similarly use `linty.noindex` below their target directory.
   Exclusion applies before building, including failed or retained test builds.
2. DMGs receive `.metadata_never_index` at the **volume root**, outside the app,
   before signing and notarizing the image. The helper preserves the app and
   Finder layout, verifies the converted image and marker, then signs it. The
   installed app therefore remains searchable. The macOS integration test mounts
   the resulting image under `/Volumes` and verifies indexing is disabled.
3. After publication, cleanup validates the exact tag, publication state, all
   five remote asset digests and local hashes, and the expanded app's complete
   fingerprint. It unregisters and deletes only the known generated app and the
   three generated DMG paths. Failed, draft, rehearsal, or unverified outputs
   remain available for diagnosis and upload retry.
4. Before the next build, any prior bundle is renamed into that build's
   `release/previous-bundle.noindex`. This replaces the former recursive pre-build
   deletion and preserves unknown contents without copying files or scanning them.
   Redirected paths and destination conflicts stop the build.

## Resource and deletion boundaries

No new code runs in the customer's app: the Rust change is test-only. No disk
search, recurring cleanup, Spotlight restart, indexing reset, or additional
update download is introduced. Customer documents, settings, history, models,
Downloads, Applications, and Trash are not cleanup targets.

Artifact verification reuses a 64 KiB buffer and rejects non-regular files or
artifacts larger than 2 GiB. It stops if file length changes. App fingerprinting never follows
links, limits traversal to 10,000 entries and 32 levels, and rejects app contents
over 1 GiB. These bounds apply to the maintainer's generated app only. Changed
or extra files and redirected cleanup paths stop cleanup before any deletion.
Conversion retains the original DMG until verification and signing succeed;
failed unmounts retain temporary storage instead of deleting through a mount.
No credentials or customer data enter verification records.

## Validation

- Actual updater installation into a synthetic Applications directory replaces
  the existing app, removes obsolete app resources, and preserves an unrelated
  neighboring app. The existing signed-download rejection test remains intact.
- A real DMG test preserves a signed fixture app and Applications link, verifies
  the resulting DMG signature, confirms the root-only marker, and checks macOS's
  disabled indexing state after mounting under `/Volumes`.
- Cleanup tests cover draft/wrong releases, remote/local/cached hash mismatches,
  new or changed app files, symlink redirection, failed unregistration, bounded
  traversal, conversion failures, and unmount failures.

These checks do not claim to prevent deliberate manual duplicate copies or erase
all historical macOS search caches. A manually retained second app remains under
the customer's control. The fix prevents our build/installer artifacts from being
indexed and avoids creating a new cleanup mechanism on customer computers.
