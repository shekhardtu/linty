# Privacy notice implementation — 20 September 2026

The current notices describe the local-only app on main. They use the Linty project name, with no newly published personal contact details or country-targeting claims. They describe technical behavior; they do not certify legal compliance or guarantee protection against claims. Where applicable law requires an operator identity or a private contact, omitting those details does not remove that obligation.

## Shared notices

`src/content/legal.json` is bundled offline in onboarding, Privacy & storage, and About. `scripts/legal-docs.mjs` generates `PRIVACY.md`, `TERMS.md`, and the website privacy and terms pages. `yarn legal:check`, included in the build, detects stale generated copies. No operator, company, DPO, representative, or certification is invented.

The notice covers local speech and cleanup, microphone and Accessibility permissions, clipboard copies, local history and optional audio saving, attribution and correction learning, retention and deletion, model downloads, automatic updates, and diagnostic logs. The reset dialog describes what deletion actually covers. Tests and focused recordings use normal local History storage; their temporary on-screen list is not their only copy.

## Website hosting

Yofix hosts linty.ai. The live host was observed injecting `/__yofix/analytics.js?v=2`, absent from source. That script sends paths, referrers, viewport width, event IDs, and performance/interaction measurements to `/__yofix/beacon`. It skips automated browsers, so an ordinary browser test alone does not establish that analytics is disabled for visitors.

The website source sets the observed script’s `window.__yfxaOptOut` flag before other page scripts, adds `connect-src 'none'`, sets no-referrer, and removes the remote image badge. The observed vendor script was evaluated with `navigator.webdriver = false`: it sent one beacon without the guard and none with it. This verifies that script’s opt-out behavior, not host-side logging or future host changes.

Hosting log retention, historical analytics deletion, and server-side settings have not been confirmed. The notice states that limitation. Deploy the complete `website/` directory together and verify the served pages and guard; a repository merge alone does not prove that Yofix has updated the live site. Existing binaries and old website copies retain their earlier behavior.

## Verification and limits

Node checks compare generated notices and the website connection policy. Chromium and WebKit tests check offline app notices, access before microphone permission, dialog focus, and minimum window width. These are technical checks, not a legal opinion. No blanket GDPR, national, state, or worldwide compliance claim is made.

Reference: [GDPR territorial scope and transparency requirements](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng) and [FTC privacy and security guidance](https://www.ftc.gov/business-guidance/privacy-security). Open-source licensing does not itself resolve obligations for the project’s own covered processing. Existing Git history, public account details, and the app’s signing certificate are separate from the new notices.
