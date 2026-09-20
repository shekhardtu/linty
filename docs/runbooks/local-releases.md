# Publish from your Mac

Official releases are published locally. GitHub's **Build macOS DMG** workflow
is disabled in repository settings; PR checks remain enabled. Local deployment
uses GitHub only to synchronize Git and upload release assets. It does not
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

The first command checks tools, credentials, remote-workflow state and whether
main is synchronized. It does not change Git, build, or publish. The second:

1. Fetches remote main and tags, rebases unpublished local main commits onto
   remote main, and pushes main without force. Behind-only branches fast-forward.
   It verifies local main and fetched remote main have the same commit.
2. Creates an isolated worktree from that exact local main commit. Release
   preparation chooses the next unused version and requires fresh
   `RELEASE_NOTES.md`, as described in [releases](releases.md).
3. Runs corpus, logging, Node, Rust, Swift, security, and both browser suites on
   the versioned source. Rust, Swift, Python and package caches remain on the Mac.
4. Builds and signs the app and updater archive, verifies app notarization,
   notarizes/staples the DMG, and verifies the updater signature against the
   application's configured public key using Minisign.
5. Creates `latest.json`, preserving the latest release's required-update
   minimum. An unavailable previous manifest stops publication. Add
   `--force-update` only when deliberately requiring older copies to update.
6. Fetches again and checks that local main, remote main, and the build's source
   still match. It rejects a competing release tag or an enabled/running remote
   release workflow.
7. Pushes the version tag, creates a draft GitHub release, uploads the DMG,
   updater archive, signature and manifest, then publishes after all uploads
   succeed. No main or tag push from this process starts a release runner while
   the remote release workflow is disabled.

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

## Inspect and retry

Builds are retained under `release/local/build-*` beside the repository's common
Git directory. The command prints the exact path. `release/build.json` records
the source commit, version commit, and artifact SHA-256 hashes;
`release/release-source.bundle` preserves the built commit. Failed commands retain
the worktree. Package-manager, Rust and Swift caches are under `release/local/cache`.

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
