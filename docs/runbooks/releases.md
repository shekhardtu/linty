# Customer-facing releases

Releases are currently built and published on the maintainer's Mac. Use the
`deploy` skill or follow [local releases](local-releases.md). The hosted release
workflow is disabled in GitHub and can be re-enabled without removing its file.

Run `yarn legal:check` to verify that the website and GitHub notices match the text bundled offline in the app. Update `src/content/legal.json` and run `yarn legal:generate` when data practices change. This is a consistency check, not legal certification.

Every release must explain what improved. Before merging a change to `main`, replace `RELEASE_NOTES.md` with concise, customer-facing notes for the upcoming release. Use Markdown headings and `- ` bullets, with one improvement per line. Describe the resulting behavior and any action a customer needs to take. Avoid commit titles, internal implementation details, and generic placeholders.

Run `yarn release:check` after fetching tags. Release preparation checks that the notes are meaningful and different from the highest versioned release tag, before changing versions or building. The first release using this process accepts the new notes file. A release without fresh notes fails instead of publishing stale text.

The same file is bundled in the app for offline reading, included in the GitHub release body, and copied into the updater manifest's `notes`. Keep it in downloaded CI artifacts when retrying publication. The app shows the installed version's bundled notes; it never substitutes notes for a newer, uninstalled release.

After an upgrade, Linty keeps an acknowledgment until the customer dismisses it. Fresh installs establish a version baseline without an update message. Existing installations that predate version tracking see “What's new in Linty” once, without claiming a detected upgrade. Later upgrades (including manual installer updates) show “Linty updated.” Customers can reread the notes in About and open the release's GitHub page. “You're up to date” appears only after a successful check; offline launches still show the installed version and its improvements.

For a failed publication, retry uploading the saved artifacts with `scripts/publish-release.sh TAG`. For a new release, write new notes. Required updates use the same notes and acknowledgment; see [force updates](force-update.md).

## Pull request check scope

Expensive jobs opt in through positive watch paths; website and documentation
changes use lightweight checks by default. The classifier reads the complete Git
diff, including deleted paths, rather than maintaining a growing exclusion list.

| Watched inputs | Checks |
| --- | --- |
| `src/**`, `public/**`, app HTML entry points, Vite/TypeScript configuration, `tests/ui.*`, browser preview fixtures | Node tests/build plus browser-app suites; no macOS jobs |
| `src-tauri/**`, native validation scripts, benchmark tooling and Python tests | Node tests/build plus Apple Silicon macOS native, corpus and logging checks; no browser-app jobs |
| Both app and native inputs | Full suite |
| Package manifests/lockfiles, release/build tooling, workflow/actions files, or the scope rule/tests | Full suite |
| Other `scripts/**` or `tests/**` changes | Node tests, website JavaScript syntax, production app build/typecheck, audit and notices |
| No watched app/native/tooling inputs (including website and docs changes) | Website behavior, privacy/legal consistency, scope tests and JavaScript syntax; no app install/build |

The exact patterns live in `scripts/check-scope.mjs`. Keep the watch paths aligned
when adding a new application build input outside these locations. Shared legal
JSON is under `src/`, so it gets app checks without native builds. Any dependency,
build or CI watch wins over cheaper scopes. Missing, malformed or unreadable diffs
and release/non-PR runs require full validation. CI rule changes validate themselves
with one full run.

Hosted native checks run only on Apple Silicon to conserve GitHub Actions
minutes. Intel compilation and tests belong to the local release flow, which
always tests both Rust targets (Intel through Rosetta), builds the universal app,
and verifies both executable architectures before publication. A full PR suite
does not replace these local native checks.

The `Required checks` gate requires every selected job to succeed and rejects
failures, cancellations, missing jobs, and unexpected skips. Only full successful
PR checks save the source artifact used to reuse application release validation;
partial checks cannot stand in for release validation. Superseded runs are
automatically cancelled by the workflow concurrency rule.

## Optional hosted build timing and validation

This section applies when the remote release workflow is enabled.

The release workflow builds and notarizes the candidate while validating its source. For a main push, it looks for the merged PR's latest successful `Checks` run. Successful full PR checks save the tested merge commit in a small artifact, retained for seven days. The release compares that commit's complete Git tree with the main commit, including workflows, tests, dependencies, and release notes. Identical trees reuse the PR suite even when squash/rebase merging changes the commit SHA. This currently applies to PRs from branches in this repository; fork PRs and website-only checks require a fresh suite.

Missing or expired evidence, changed trees, failed/pending checks, direct pushes, and API errors trigger the full suite. Manual workflow runs always run fresh checks, including `build_only` timing runs. The release summary links to any reused PR run. The build still runs Node and Rust tests after preparing the release version, then signs and notarizes the app. Publication requires a successful build and either verified PR checks or a successful fresh suite. Only the publication job has repository write permission; it verifies the transferred version commit against the original source SHA before tagging it.

To check warm-cache performance without creating another release:

```bash
gh workflow run build-dmg.yml --ref main -f build_only=true
```

This runs the same builds, signing, notarization, and checks, and saves artifacts. It does not create a tag or publish a release. It allows unchanged release notes for repeated timing runs; normal releases still require new notes. Native compilation preserves incremental Rust and Swift test outputs, and both checks and release builds reuse the same exactly keyed Swift bridge archive. Expect a cold build when the compiler, SDK, architecture, or dependencies change; inspect the cache hit and step durations before comparing runs.
