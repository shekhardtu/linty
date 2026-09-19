# Customer-facing releases

Every release must explain what improved. Before merging a change to `main`, replace `RELEASE_NOTES.md` with concise, customer-facing notes for the upcoming release. Use Markdown headings and `- ` bullets, with one improvement per line. Describe the resulting behavior and any action a customer needs to take. Avoid commit titles, internal implementation details, and generic placeholders.

Run `yarn release:check` after fetching tags. Release preparation checks that the notes are meaningful and different from the highest versioned release tag, before changing versions or building. The first release using this process accepts the new notes file. A release without fresh notes fails instead of publishing stale text.

The same file is bundled in the app for offline reading, included in the GitHub release body, and copied into the updater manifest's `notes`. Keep it in downloaded CI artifacts when retrying publication. The app shows the installed version's bundled notes; it never substitutes notes for a newer, uninstalled release.

After an upgrade, Linty keeps an acknowledgment until the customer dismisses it. Fresh installs establish a version baseline without an update message. Existing installations that predate version tracking see “What's new in Linty” once, without claiming a detected upgrade. Later upgrades (including manual installer updates) show “Linty updated.” Customers can reread the notes in About and open the release's GitHub page. “You're up to date” appears only after a successful check; offline launches still show the installed version and its improvements.

For a failed publication, retry uploading the saved artifacts with `scripts/publish-release.sh TAG`. For a new release, write new notes. Required updates use the same notes and acknowledgment; see [force updates](force-update.md).
