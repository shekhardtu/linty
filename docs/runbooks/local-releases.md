# Publish from your Mac

Official releases are published locally. GitHub's **Build macOS DMG** workflow
is disabled in repository settings; PR checks remain enabled. Local deployment
uses GitHub to synchronize Git, report release checks, and upload release assets. It does not
dispatch an Actions workflow or use a self-hosted Actions runner.

In Codex, invoke the `deploy` skill as `$deploy` or select it in the skill picker.
This repository also treats `/deploy` as shorthand through `AGENTS.md`. Codex's
skill picker is the supported UI entry point; the shorthand is a project
instruction, not a registered built-in slash command.

## Set up once

Use an Apple Silicon Mac with full Xcode and Swift 6+, Rust with rustfmt, Node
24+, Yarn Classic, GitHub CLI authenticated with write access to
`shekhardtu/linty`, Python 3.12+, and Minisign. The default Python command is
`python3.13`; set `LINTY_RELEASE_PYTHON` to another compatible executable if needed.
For the additional release tools, Homebrew provides `python@3.13` and `minisign`.

Install both Rust targets:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

Rosetta must be installed on the release Mac to run the Intel test binaries.
The prerequisite check verifies Intel execution with `arch -x86_64 /usr/bin/true`.
Apple Silicon and Intel compilation, Rust tests and Swift tests run here instead
of on hosted PR runners to conserve GitHub Actions minutes. They always run before
publication, including when the release reuses successful PR browser checks.
Releases produce one **universal macOS 14+ app**: Apple silicon includes the
Swift/Parakeet bridge and Metal inference; Intel includes Whisper and S1-mini CPU
inference without the Swift bridge or Metal kernels. The two architectures share
resources and download model weights separately. Windows, Linux, and iOS builds
are not supported.

Each release includes `linty-VERSION.dmg` and an identical `linty.dmg` alias
for existing external links. The website resolves the latest release to the
versioned asset so downloaded files identify their version. Both `darwin-aarch64` and
`darwin-x86_64` updater entries reference the same signed universal archive,
including updates from existing Apple-silicon-only installations. Publish the
first universal release before deploying website links to this new asset name.

The installer volume contains `.metadata_never_index` at its root so Spotlight
does not index the mounted installer as a second application. The marker is
outside `Linty.app`: dragging the app to Applications leaves the installed copy
searchable. `scripts/prepare-macos-dmg.mjs` adds and verifies the marker, preserves
the signed app and Finder layout, and signs the resulting DMG before notarization.
Both local release and `yarn build:mac` use this step. The retained, disabled
hosted workflow uses it too; do not enable that workflow to run a local release.

The Developer ID Application certificate **and its private key** must be in
Keychain, with signing access available. Supply the existing credentials through
your secure environment:

- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD` (Apple app-specific password)
- `APPLE_TEAM_ID`
- `TAURI_SIGNING_PRIVATE_KEY` (the existing updater key or its absolute file path)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (export an empty string if the key has no password)

Use the existing updater key so installed copies can verify updates. GitHub
Actions secrets cannot be downloaded; configure these locally from your own
secure copies. The command does not load dotfiles or write secret values to disk.

## Deploy

From a clean worktree checked out on `main`:

```bash
yarn release:local --check
yarn release:local --publish
```

Every release asks **Required or Optional?** There is no default or remembered
answer. The deploy skill asks in chat; the command asks in an interactive
terminal. After answering in chat, the skill passes `--release-type required` or
`--release-type optional` so the terminal does not ask again. Noninteractive
publishing requires that explicit choice.

- **Required:** this version becomes the minimum supported version. Older copies
  download automatically and install/restart when dictation is idle.
- **Optional:** supported copies show that an update is available; the customer
  chooses when to install. An existing minimum from a previous required release
  remains enforced for copies below that minimum.

Versions always advance by **patch** (for example, `0.0.60` → `0.0.61`) unless
the user explicitly requests `--bump minor` (`0.1.0`) or `--bump major` (`1.0.0`).
Release type and version size are independent; a required update still defaults
to patch. Version selection advances beyond both source versions and used tags.

For an explicitly requested history restart, set all four app manifests to
`0.0.1` in the single initial commit, then use `--initial-release` instead of a
version bump. This option requires no existing version tags or GitHub releases
and tags the initial commit itself. It never deletes history or changes branch
protection. Example after choosing Optional:

```bash
yarn release:local --publish --initial-release --release-type optional
```

The first manifest starts without a previous minimum version. Existing copies
with a higher version number need a manual reinstall; restarting at `0.0.1`
does not make their updater accept a downgrade. Later releases use normal patch
bumps and the usual version-only release commit.

The first command checks tools, credentials, remote-workflow state and whether
main is synchronized. It does not change Git, build, or publish. The second:

1. Fetches remote main and tags, rebases unpublished local main commits onto
   remote main, and pushes main without force. Behind-only branches fast-forward.
   It verifies local main and fetched remote main have the same commit.
2. Creates an isolated worktree from that exact local main commit. Release
   preparation chooses the next unused version and requires fresh
   `RELEASE_NOTES.md`, as described in [releases](releases.md).
3. Runs corpus, logging, Node, Rust, Swift and security checks on the versioned
   source. Browser suites reuse the latest successful PR result only when its
   saved tested commit has exactly the same complete tree as main. Missing,
   expired, failed or mismatched evidence runs every browser suite locally in
   WebKit, the engine used by the macOS app. Chromium is not part of release validation.
   The same `yarn test:browsers` runner serves PRs and local releases: two suites
   run concurrently, each on a separate port, with the longest suites first.
   Rust, Swift, Python and package caches remain on the Mac.
   Records a pending `release/local` commit status on the source main commit
   before validation; any validation/build failure records failure and stops.
4. Tests both Rust targets (Intel through Rosetta), builds the universal app,
   verifies that its executable contains both ARM64 and x86_64, signs the app and updater archive, verifies app notarization,
   notarizes/staples the DMG, and verifies the updater signature against the
   application's configured public key using Minisign.
   Browser checks overlap universal compilation, app signing and app notarization.
   Packaging reuses the already validated frontend build, so it cannot rewrite
   files while the security suite reads them. Both branches must pass before
   artifact verification or publication proceeds; failure cancels the other branch.
5. Creates `latest.json`, preserving the latest release's required-update
   minimum for Optional, or raising it to the new version for Required. An
   unavailable previous manifest stops publication, except the explicitly
   requested initial release with a confirmed empty release history.
6. Fetches again and checks that local main, remote main, and the build's source
   still match. It rejects a competing release tag or an enabled/running remote
   release workflow.
   All validation and artifact verification must pass, and GitHub must accept
   the successful release-check status, before publication can start.
7. Pushes the version tag, creates a draft GitHub release, uploads the DMG,
   updater archive, signature and manifest, then publishes after all uploads
   succeed. No main or tag push from this process starts a release runner while
   the remote release workflow is disabled.
8. Verifies the published release's asset digests against the saved build record
   and local files, then automatically removes its staged DMGs, cached DMG, and
   expanded build copy of `Linty.app`. It unregisters only that build app from
   Launch Services before removal. The installed application, signed updater
   archives, signatures, manifest, source bundle, build record, and compilation
   caches remain. Failed/draft releases and build-only runs retain their artifacts.
   If verification or cleanup fails after publication, the command reports the
   cleanup failure separately; do not publish another version to retry cleanup.

The app's version-only commit lives on the release tag, with synchronized main
as its parent, just as in the hosted workflow. Product code comes from main;
the process does not push version bumps around main's branch protection.

Dirty main worktrees stop before synchronization. Conflicts abort the attempted
rebase and restore the local commits. A protected-branch push rejection stops
before building: merge the local commits through a normal checked PR, then
deploy again. The deploy skill can handle that PR within the deployment request;
those ordinary PR checks still use GitHub Actions. It never bypasses protection
or force-pushes main. If main changes during compilation, rebuild the new main.

For a complete signed and notarized local rehearsal without publishing:

```bash
yarn release:local --build-only
```

This still synchronizes/pushes main and runs validation, but creates no release
tag or GitHub release. It permits unchanged release notes for timing runs.
It also updates the release-check status after validating the signed build.

## Release checks badge

The public README shows the latest published release version. PR checks and
local release validation are maintainer signals and are inspected separately:

- **[PR checks](https://github.com/shekhardtu/linty/actions/workflows/checks.yml?query=event%3Apull_request)**
  report `pull_request` runs of `checks.yml`. Their checks depend on the changed files: website/docs checks, Node
  tests and app build, corpus tests, native source/security checks, and WebKit UI
  suites. It does not represent a local release or native compilation.
- **Local release validation** uses GitHub's commit status on the source commit. The
  local release command writes the `release/local` context on the exact source
  commit, pending before validation, failure if validation/building fails, and
  success only after the full validation, universal build, signatures,
  notarization, updater verification, manifest and build record succeed.

The local suite includes Node tests and app build, dependency audits and license
notices, corpus tests, Rust formatting/logging/security checks, Rust tests for
Apple Silicon and Intel (through Rosetta), Swift tests, supervisor tests, and
eight browser suites in WebKit. Browser results are reused
only with verified PR evidence for the identical source tree; native tests
always run locally. Passing PR checks alone cannot authorize publication.

`$deploy` uses this reporting automatically through `release-local.mjs`.
`--check` is still read-only and does not mark tests passed. A new main commit
with no local validation has no `release/local` status; it never inherits another
commit's success. A combined-status badge pointed at that commit can show pending,
which is why the public README uses the published release version instead.
An interrupted process may leave pending until rerun. The status reports
validation, so a later upload failure leaves the successfully verified build
marked passed.

GitHub authentication needs commit-status write access (`repo:status` or `repo`
for a classic token; **Commit statuses: Read and write** for a fine-grained
token), in addition to release access. Failure to record pending or success
stops the command before publishing. If failure reporting itself is unavailable,
the original error is preserved and the command warns that GitHub may be stale.
No status contains local paths, credentials, or raw command output. Status
updates start no Actions jobs. Inspect the `release/local` context on the source
commit for local validation; GitHub's combined status may also include contexts
from other integrations.

## Inspect and retry

Builds are retained under `release/local/build-*` beside the repository's common
Git directory. The command prints the exact path. `release/build.json` records
the source commit, version commit, release type, version bump, browser validation
evidence, and artifact SHA-256 hashes;
`release/release-source.bundle` preserves the built commit. Failed commands retain
the worktree. Package-manager, Rust and Swift caches are under `release/local/cache`.

Cargo output lives in `cache/target.noindex`, which Spotlight excludes. The first
run migrates the previous `cache/target` directory without discarding compiled
dependencies and leaves a compatibility symlink for Cargo's recorded absolute
paths. Standalone `yarn build:mac` similarly uses a `linty.noindex` subdirectory
of its target directory. Failed and rehearsal builds remain excluded too.

Cleanup uses only fixed paths inside this build and its dedicated output cache.
It rejects redirected paths, verifies all five uploaded artifacts, and compares
the expanded app's complete content fingerprint with the build record. Extra or
changed files cause cleanup to stop without deleting anything. It never searches
Applications, Downloads, documents, or customer data. Hashing uses a 64 KiB buffer;
there is no cleanup service, timer, Spotlight reset, or disk scan in the shipped app.
See [the investigation and validation](../reviews/spotlight-installation.md).

Uploads retry independently three times. If a later retry is needed, inspect
the saved build record, verify the hashes and source relationship, and ensure
local and freshly fetched remote main still match its `sourceSha`. Confirm the
tag points to `builtSha` and the GitHub release is still a draft. Then run
`bash scripts/publish-release.sh vVERSION` from the saved build worktree with
`GH_REPO=shekhardtu/linty`. If draft creation failed, recreate the draft with
`gh release create vVERSION --repo shekhardtu/linty --verify-tag --draft
--title 'Linty vVERSION' --notes-file RELEASE_NOTES.md` first. Never replace the
assets of an already published release. Rebuild if the source or artifacts differ.

Only one local release may run at a time. After a killed process, check that no
release process is still running before removing its `release/local/.lock`
directory. Remove obsolete build worktrees with `git worktree remove` after
publication and any retry needs are finished; keep the shared caches.

## Re-enable hosted releases

The workflow file is retained, including its PR-result reuse optimization.
To return to automatic hosted releases on main pushes and manual dispatches:

```bash
gh workflow enable build-dmg.yml --repo shekhardtu/linty
```

To switch back to local publishing:

```bash
gh workflow disable build-dmg.yml --repo shekhardtu/linty
```

Disabling does not cancel an already-running release. Wait for it to finish.
Local deployment refuses to publish while hosted releases are enabled or a
hosted release is still running.
