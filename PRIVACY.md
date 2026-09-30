<!-- Generated from src/content/legal.json by scripts/legal-docs.mjs. -->
# Privacy notice

Updated 2026-09-30

Linty is open-source dictation software. This notice describes the official app and linty.ai. Forks and other distributions may differ.

## On your Mac

Speech recognition and optional text cleanup run on your Mac and work offline after model download. Linty does not upload your recordings or transcripts. Optional telemetry combines limited usage statistics and technical error reports in one choice. It is preselected during setup, with a heads-up and confirmation before collection.

Microphone access records dictation and microphone tests. Accessibility access supports shortcuts and pasting. Pasting uses the clipboard; receiving apps and clipboard managers may keep or sync copies.

## Storage and your choices

History, corrections, and your dictionary are saved locally. History stays until deleted by default. Audio saving is off by default; enabling it retains recordings with successful dictations. Local history and audio are not separately encrypted by Linty.

App attribution is on by default and saves the active app’s name and identifier with dictations. Automatic dictionary learning and observing corrections in other apps are off by default. Enabling observation reads supported text fields for up to two minutes after pasting and saves relevant corrections, not the full field.

Settings → Privacy & storage provides retention, export, and deletion controls. Optional history expiry runs at most once per 24 hours while Linty is running. Turning off a saving preference does not delete earlier records. Deleting a transcript removes its recording and corrections; dictionary entries remain separate.

Reset removes Linty’s application data and downloaded models. It does not erase diagnostic logs, exports, backups, or copies in other apps. The project cannot remotely access or delete your local archive.

## Optional telemetry

The Share telemetry choice is preselected during setup. Nothing is sent before you confirm it; turn it off before continuing if you prefer. Settings → Privacy & storage lets you change your choice later. Existing installations receive a one-time heads-up when telemetry is first introduced. Ordinary upgrades preserve your saved choice without asking again.

Telemetry sends app launches, Linty page names, setup completion, dictation outcomes, elapsed and processing duration ranges, speech engine category, whether cleanup was enabled, and fixed error categories for dictation stages and interface failures. Reports include Linty’s version, build architecture, and event time. Rust panic reports are best effort; this integration does not include full native crash reports.

A random installation ID links events across launches to count participating installations, returning usage, and installations affected by failures. It is not derived from your name, account, hardware, or network address. This is pseudonymous, not completely unlinkable. Turning sharing off deletes the ID; enabling it again creates a new one.

No recordings, transcripts, clipboard contents, dictionary words, prompts, custom model names, source file paths, names of other apps, raw error messages, stack traces, diagnostic logs, memory dumps, account names, or hardware identifiers are uploaded. There is no session replay, screenshot capture, or automatic click tracking. Existing local history is never backfilled.

Events are sent to the PostHog Cloud region configured in the installed build. PostHog receives the network address of requests; event payloads suppress IP storage and geolocation and do not create person profiles. The provider retains received events according to its service and project settings. Its privacy policy describes its own processing.

Turning sharing off stops new collection and discards queued events. Pending events are held only in memory, with a short expiry. Requests already received by PostHog cannot be recalled, and disabling sharing does not delete those earlier events. Reset revokes sharing and deletes the local installation ID. If saving an opt-out fails, sharing stops for that session and the app asks you to retry before quitting.

[PostHog privacy policy](https://posthog.com/privacy)

## Downloads, updates, and diagnostics

Setup downloads models from Hugging Face and its delivery services. Linty automatically checks GitHub for updates; required updates can download and install when dictation is idle. These hosts receive IP addresses and request metadata. On-device speech processing does not disable these connections.

Technical diagnostic logs stay on your Mac unless you share them. They rotate by size, with four archives and an active file of roughly 5 MiB each. Review exported diagnostics before sharing.

[GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) · [Hugging Face privacy policy](https://huggingface.co/privacy)

## Website and GitHub

Yofix hosts linty.ai and receives connection metadata. Its injected analytics has been observed sending page paths, referrers, viewport width, event IDs, and performance measurements. This website’s source opts out of that observed script and blocks analytics connections; this does not disable host-side logs. Host retention has not been confirmed.

The landing page requests public release information from GitHub to refresh the download count and link to the latest versioned installer. GitHub receives your IP address and request metadata. These requests omit credentials and referrers. The count combines installer and app update downloads across published releases, including repeated downloads; it excludes signatures and update checks and does not identify unique people or confirm installations. If GitHub is unavailable, the page keeps its dated snapshot and links to GitHub’s latest release page.

The website saves your chosen theme and motion preference in browser storage until you change them or clear site data. Platform detection happens in your browser.

GitHub issues and contributions may be public. Use them only for non-sensitive reports; do not post recordings, private transcripts, API keys, or personal privacy requests.

## About this notice

The date above identifies this notice. The app includes the notice for its installed version, available offline. The website may describe a later version. This notice describes data practices and does not certify legal compliance or waive rights provided by applicable law.
