# Optional PostHog telemetry

One **Share telemetry** choice covers usage statistics and limited technical
reports. It is **preselected during setup**, with a heads-up and confirmation
before any collection. Customers can turn it off before confirming, or later in
**Settings → Privacy & storage**. Setup works with sharing off. Rust saves the
explicit choice before collection begins. Existing local history is never
uploaded or backfilled.

The first release introducing telemetry presents existing installations with a
one-time heads-up and the same preselected choice. Ordinary upgrades preserve
that saved choice and do not ask again. A future expansion of the collected data
must version the consent contract and request confirmation again.

## Identity and metrics

Sharing creates a random UUID only when enabled and saves it with the consent in
`linty-settings.json`. It is not derived from a name, account, hardware identifier,
or network address. It links usage across launches, so describe this as
**pseudonymous**, not completely unlinkable. Turning sharing off removes the ID;
re-enabling, resetting data, or reinstalling with cleared settings creates a new
one. Count **participating installations**, not people or all customers.

Technical reports use the same installation ID, allowing counts of affected
participating installations. All events set `$process_person_profile: false`,
`$geoip_disable: true`, and `$ip: "0.0.0.0"`. PostHog still receives the connection's
network address. Also disable IP address capture and GeoIP enrichment in the
project settings.

## Event contract (schema 1)

Every event carries `app_version`, `platform: macos`, `architecture`, and
`schema_version`, plus a capture timestamp and the relevant random ID.

| Purpose | Event | Additional fields |
| --- | --- | --- |
| Usage | `app_session_started` | None; once at launch with saved consent, or when enabled |
| Usage | `page_viewed` | Allowlisted Linty page name |
| Usage | `onboarding_completed` | None |
| Usage | `dictation_finished` | Allowlisted outcome, elapsed and processing duration ranges, speech engine, cleanup enabled |
| Technical | `$exception` | Fixed failure category, handled flag, severity and fingerprint |

Elapsed ranges cover the entire dictation session (recording and processing),
not an exact audio length or an inference benchmark. Processing ranges measure
time from stopping recording until the result is finished: under 1 second, 1–3,
3–10, 10–30, or over 30 seconds. Speech engine is allowlisted as Whisper,
Parakeet, or other; custom model names and paths are never sent. Outcomes distinguish
verified insertion, unverified insertion, failure, no speech, cancellation, and
skipped delivery. Cancellation and no speech are not technical errors. Error
categories cover recording start/stop, preparation, transcription, cleanup,
history writes, delivery, interface errors/rejections/render errors, and Rust
panics. No arbitrary messages or properties cross the telemetry API.

Audio, transcripts, clipboard contents, dictionary words, prompts, source file
paths, names of other applications, raw error messages, stack traces, local
logs, screenshots, session replay, memory dumps, and automatic click capture
are excluded. Existing app attribution is a separate local history preference.

## Collection and opt-out

Rust owns the consent gate and uses PostHog's [capture HTTP API](https://posthog.com/docs/api/capture).
A small explicit adapter gives us control over the event allowlist and queue;
there is no browser SDK or its default autocapture behavior. Dictations snapshot
consent when starting. Enabling sharing partway through a dictation cannot send
that earlier session, and old consent tickets cannot become valid again after
an off/on cycle. Frontend events carry the current consent epoch over IPC so a
delayed request from an earlier choice cannot be collected under a new ID.

The memory-only queue holds at most 64 events for at most 60 seconds, and
technical reports are limited to 20 per minute. Requests time out after five
seconds, follow no redirects, and are not retried or persisted. Network failures
drop events and do not interrupt dictation. Quitting can lose pending events.
Opt-out purges queued events and cancels in-flight HTTP work where possible;
requests already received by the provider cannot be recalled. Reset revokes
sharing before clearing settings and removes the installation ID.

If an opt-out disk write fails, sharing is still stopped for this session and
the interface asks the customer to retry before quitting. Previously saved
consent can otherwise be restored at the next launch. Enabling never takes
effect after a failed disk write.

## Crash reporting limits

The existing local Rust panic hook also queues a sanitized `rust_panic` event.
This is best effort: a terminating process may exit before upload. It contains
no panic message or stack and is not a complete native crash reporter.

PostHog's [Apple SDK supports macOS native crashes](https://posthog.com/docs/error-tracking/installation/ios)
(Mach exceptions, POSIX signals, and uncaught NSExceptions), saving reports for
the next launch. That SDK bridge and dSYM release uploads are **not included in
this integration**. Before adding them, explicitly review and filter the saved
crash payload, prevent pre-consent capture, delete pending reports on opt-out,
and recheck current consent before next-launch upload. The Rust-only SDK does
not provide that Apple crash mechanism automatically.

## Maintainer setup

1. Create a PostHog organization and a project named **Linty Desktop** at
   [EU Cloud](https://eu.posthog.com/) or [US Cloud](https://us.posthog.com/).
   The project has no special Mac application type; skip automatic installation.
2. In **Settings → Project → General**, copy the public **Project token**
   beginning with `phc_`. A personal API key or account password is unnecessary.
3. Supply these environment variables to the Rust build / release process:

   ```sh
   export LINTY_POSTHOG_PROJECT_TOKEN='phc_your_project_token'
   export LINTY_POSTHOG_HOST='https://eu.i.posthog.com'
   ```

   Use `https://us.i.posthog.com` for US Cloud. Both values are compiled into
   the app; setting them only after compilation has no effect. The token is a
   public ingestion credential, not permission to read the dashboard. This
   adapter accepts only these two HTTPS cloud hosts. Missing or invalid
   configuration disables sharing; there is no fallback to another region.
   A `.env` file alone is not automatically loaded by Cargo: export values into
   the environment used to build. Keep personal API keys out of the app.
4. Disable project IP capture and GeoIP enrichment. Keep PostHog's organization
   **AI model training** setting off (check it even if EU defaults off). Leave
   session replay and exception autocapture off; our adapter sends explicit
   `$exception` events without the Apple/browser SDKs. Review provider retention
   and billing settings, and set a spending limit if attaching a card.
5. Use an isolated test installation; verify the unconfirmed choice and sharing off produce no
   ingestion requests, confirm sharing and make a dictation, then check the
   activity feed. Confirm the ID persists across launches. Test a controlled failure; check Error Tracking. Disable sharing and confirm
   subsequent requests stop. Inspect the actual
   received event properties for this contract before publishing a release.

Build dashboards for daily/weekly active participating installations (unique
usage IDs across usage events), session counts, dictation outcomes, cleanup
adoption, version distribution, and retention using `dictation_finished`.
Do not label downloads or participating installations as total users.

## Questions the dashboard can answer

| Metric | Question / visibility | Definition and limit |
| --- | --- | --- |
| Daily / weekly / monthly active installations | How many participating copies are being used? | Unique installation IDs with usage events in the period; not total users or installed copies |
| New participating IDs | Is observed adoption growing? | First usage event per ID; re-enabling or clearing data creates a new ID |
| Returning installations / retention | Do participating installations come back to dictate? | Same ID performs dictation again after a day/week/month; opt-out is indistinguishable from inactivity |
| App session starts | How often is Linty launched? | `app_session_started`; first confirmation also starts an observed session |
| Dictation volume | Is real dictation activity growing? | Count `dictation_finished`; terminating crashes can prevent completion reporting |
| Dictation outcomes | Are dictations verified, unverified, failing, empty, cancelled, or skipped? | Outcomes remain separate; unverified is not counted as verified success |
| Processing speed distribution | Which versions or engines are getting slower? | Processing time ranges by version / engine; no exact p50 or p95 from these buckets |
| Session duration distribution | Are dictation sessions mostly short or long? | Elapsed ranges include both recording and processing |
| Speech engine adoption | Are participating copies using Whisper or Parakeet? | Known engine category per dictation, never a custom model path |
| Cleanup adoption | Is optional cleanup being used? | Fraction of dictations with cleanup enabled; not a measure of output quality |
| Page usage | Which Linty areas are visited? | Fixed Linty page names; no clicks, search text, or other-app activity |
| Setup confirmations | How many sharing installations finish setup? | `onboarding_completed`; first-run abandonment before confirmation is invisible |
| Version and architecture distribution | Are installations updating? Are failures concentrated in Intel or Apple silicon builds? | Usage events by Linty version and `x86_64` / `aarch64` |
| Failure categories / affected installations | Which stages need engineering attention? | `$exception` counts and unique IDs by category / version; rate-limited and best effort |

For active-installation and retention charts, filter to usage events, excluding
`$exception`. Keep cancelled/no-speech dictations separate when calculating
success rates. There is no precise transcription accuracy or “hours saved”
metric: no transcript, word count, correction content, or audio is collected.
There is also no geography, hardware model, per-app attribution, user identity,
pre-confirmation onboarding funnel, full native crash stack, or raw log search.
These figures describe the participating subset and can undercount when offline,
when the queue expires, or when an app quits before upload.

## Verification

`cargo test --features local-stt telemetry::tests` covers fail-closed consent,
confirmation before collection, stale tickets, opt-out/ID rotation, payload fields,
queue bounds, configuration, and the HTTP cancellation boundary.
`yarn test:privacy` exercises the settings controls, persistence, and offline
notice. Live ingestion verification additionally requires a configured project.
