# Force update runbook

How to make every copy of Linty below a version install the latest release. Everything happens on GitHub; there is no update server.

## How it works

- Each GitHub release has a `latest.json`. The app reads the one from the latest release at launch, every 15 minutes and when the Mac wakes.
- If that file has `minimum_version` and the app is below it, the release is required. The app shows a screen that cannot be dismissed and downloads the update. It installs 30 seconds after the last dictation, then restarts. Dictation keeps working until then.
- Without `minimum_version`, updates stay optional, as before.
- The field is not signed. It cannot make a copy install anything except the latest release, which the updater verifies with the release key. The worst a wrong value can do is require the latest release.
- Builds before v0.0.40 ignore the field. They still offer the update as optional.

## When an existing copy cannot find an update

The requirement takes effect only after the installed app reads `latest.json`. It cannot repair an unreachable update connection remotely.

Versions through v0.0.55 can spend the entire check timeout connecting to one unreachable GitHub release CDN address. Background failures can also leave no visible error. Newer builds bound connection attempts, try other resolved addresses sooner, show failed checks, and retry automatically.

If an older copy remains stuck, download the latest signed DMG from [GitHub Releases](https://github.com/shekhardtu/linty/releases/latest), quit Linty after dictation finishes, replace the app, and reopen it. Keep the app's existing data and settings; do not use Reset All Data. This one-time installation gives the copy the repaired updater. Working older connections can receive the same release through the normal required-update flow.

## Require an update

For a release that is already published, run this from the repository:

```bash
node scripts/force-update.mjs --show            # what is required now
node scripts/force-update.mjs --latest          # everyone below the latest release
node scripts/force-update.mjs 0.0.40            # everyone below 0.0.40
```

Add `--dry-run` to see the new `latest.json` without uploading. The script uses the GitHub CLI, so `gh auth status` must show write access to `shekhardtu/linty`. It waits until GitHub serves the change.

For a release that is about to be built, run the "Build macOS DMG" workflow by hand (Actions → Build macOS DMG → Run workflow) with **Require every older copy to install this release** ticked. The new release is published with `minimum_version` set to its own version.

Every new release keeps the minimum of the release before it, so an ordinary release never drops a requirement. The build reads that minimum just before it publishes, so don't change the minimum while "Build macOS DMG" is running: the script refuses to, and `--show` after a release confirms the requirement is still there.

## Undo

```bash
node scripts/force-update.mjs --clear --allow-lower
node scripts/force-update.mjs 0.0.38 --allow-lower
```

A copy that has already downloaded a required update checks again just before installing. If the requirement is gone, it doesn't install.

## A bad release

There is no downgrade. Fix forward:

1. Mark the bad release as a pre-release so copies that have not updated yet stop being offered it: `gh release edit v<bad> --prerelease`. The previous release becomes the latest again.
2. Revert or fix the change and merge it. CI publishes a new, higher version.
3. `node scripts/force-update.mjs --latest` so everyone on the bad release moves to the fix.
