# Linty website

Static landing page for [linty.ai](https://linty.ai), hosted by Yofix. No runtime dependencies. Legal pages are generated from the same content bundled in the app: run `yarn legal:generate` after editing `src/content/legal.json`, then `yarn legal:check`.

Run `yarn legal:check` before publishing to verify that the website and app notices match. This is a consistency check, not legal approval. See the [privacy implementation review](../docs/PRIVACY-RELEASE-REVIEW.md). Verify the live host as well as repository source: Yofix was observed injecting `/__yofix/analytics.js?v=2` on 20 September 2026. `privacy-guard.js` opts out of that observed implementation and the page CSP blocks fetch and beacon requests. These measures do not disable server logs or prove anything about historical collection. Disable injection at the host and verify retention and processing locations. Browser automation is insufficient by itself: the observed script skips `navigator.webdriver` sessions.

The landing page and both legal pages load local assets, set a no-referrer policy, and expose privacy and responsible-use links. Keep the early privacy guard and CSP before all other scripts. There is no embedded third-party download badge on the prepared website.

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory website
# http://127.0.0.1:4173
```

Deploy this directory with an existing static host.

Website-only pull requests run focused checks without installing or building the
desktop application. Run the same tests locally with
`node --test tests/website-*.test.mjs tests/privacy.test.mjs tests/check-scope.test.mjs`.
Application, dependency, shared-tooling, and workflow changes still run the full
suite; see [check scope](../docs/runbooks/releases.md#pull-request-check-scope).

Local asset URLs in `index.html` include a `?v=` content version so returning
visitors fetch updated files. When an asset changes, update its version to the
first 12 characters of its SHA-256 hash. Keep the underlying filenames stable.
After deploying, fetch the full CSS, JavaScript, and image files with GET and
compare their contents with the local files, then check the page in a browser.
An HTTP 200 or a HEAD-only check is insufficient: an empty cached response can
also return 200.

- `index.html` — product tour, illustrated workflow, on-device privacy, language setup answers
- `styles.css` — responsive layout using the application's color and type tokens
- `theme.js` — saved/system theme, applied before paint
- `main.js` — explicit light/dark choices and download feedback
- `product.js` — slowly looping product screenshots, screen selection, and hover pause
- `platform.js` — best-effort OS detection, shared voting issues, and prefilled GitHub request links
- `demo.js` / `demo.css` — rotating Notes, Email, and Code illustrations with dictation playback
- `motion.css` / `motion.js` — animated voice motifs and bounded pointer response on Linty marks
- `images/` — actual application screenshots with synthetic example data; real macOS app icons

## Download feedback

Each download link keeps its direct installer URL. A normal click or keyboard
activation shows a spinner on that link; text buttons also show “Starting…”.
The button keeps its width, ignores repeat clicks for five seconds, then resets
so a visitor can retry. Modified clicks retain the browser's normal behavior.
The animation respects reduced motion and the site's motion control, and a live
region announces the download handoff. This indicates the start request only:
the browser owns transfer progress, cancellation, and completion.

## Feature and platform requests

Windows and Linux buttons open shared public issues:

- [Windows support #59](https://github.com/shekhardtu/linty/issues/59)
- [Linux support #60](https://github.com/shekhardtu/linty/issues/60)

Count 👍 reactions on each issue's opening post as the demand signal. Visitors
can comment with requirements and subscribe for updates. Opening a link alone
does not record a vote, and comments are not added to the vote count.

General feature requests and other platforms use the existing
`.github/ISSUE_TEMPLATE/feature_request.yml`, which applies the `enhancement`
label. Android, iOS, and ChromeOS buttons prefill the platform in the title and
both required fields. Browse all requests with `is:issue label:enhancement`.

No website login, backend, GitHub token, or additional service is involved.
GitHub requires visitors to sign in to react, comment, or submit a request.
The download spinner only applies to actual installer links. Mac and unidentified
browsers keep the macOS download; manual Windows, Linux, and other OS links remain
available to everyone, including visitors with JavaScript disabled. A separate
Mac download link is available to visitors requesting an unsupported platform.

Run `node --test tests/website-platform.test.mjs` from the repository root to
check OS classification and request URLs. Detection happens in the browser and
does not transmit a visitor's OS until they follow a GitHub request link.

## Shared branding

Icons, background motifs, and `brand/theme.css` are generated from
`src/assets/linty-mark.svg`, `src/assets/brand-artwork.json`, and
`src/styles/tokens.css`. Use `yarn icons:generate` after changing a source,
and `yarn icons:check` before deploying. See [Brand icons](../docs/BRAND-ICONS.md).
The feature-strip CPU and Command icons are rendered from the same Lucide
components used by the application, not redrawn for the website.
The page initially follows the system theme. A visitor's explicit light/dark
choice stays in browser storage on their device.

## Decorative motion

The hero's voice lines and the workflow/download contour rings use the same
geometry as the application's `BackgroundArtwork` and `SoundPattern` components.
They are vector masks, so they stay sharp at any display density. Only transforms
and opacity animate; backgrounds never intercept clicks or affect layout.

CSS motion pauses offscreen and when the document is hidden. Pointer response
only runs on hover-capable fine pointers and uses stable link bounds. Small marks
get one light sweep; the download icon has a bounded four-degree tilt, two-pixel
lift, directional highlight, and press feedback. Frame-rate-independent damping
stops requesting frames once settled, including the eased return on exit. It
resets immediately on scrolling, blur, hidden tabs, or disabled motion.
The footer's motion control remembers the visitor's choice; system reduced-motion
settings always take precedence and leave the artwork static.

## Product screenshots

Run the application Vite server and open
`http://127.0.0.1:1420/scripts/website-preview.html?theme=light` (or `dark`).
This development-only page renders the actual app using the existing in-memory
UI bridge and `scripts/website-preview-data.mjs`. It does not read native history.
Run `node scripts/capture-website.mjs` while that server is running. The exporter
renders the actual interface at a 1200 × 800 logical viewport and 2× device
scale, producing lossless **2400 × 1600 PNGs**, without a browser frame. No
existing image is enlarged. The landing page caps the display size below the
logical width and reserves the aspect ratio. Screenshots are not zoom links:

- `overview-{light,dark}.png` — initial Overview
- `history-{light,dark}.png` — History with the latest email reply selected
- `language-{light,dark}.png` — Settings → Dictation with English selected and
  on-device cleanup enabled. Customize cleanup is expanded to show writing style,
  layout, and lists. The filenames stay stable after Language moved into Dictation.

On desktop (at least 761px wide and 560px tall), the showcase scales to the
viewport height below the sticky header, with 16px of breathing room at each end.
CSS reserves 152px for the frame padding, toolbar, and two-line caption, then
derives the width from the screenshot's 3:2 ratio. The frame is centered and
capped by the page width; screenshots stay uncropped. The header and anchor
offset share a height token. Narrow or very short windows use natural scrolling
instead of shrinking the screenshots further. Recheck the reserved space if the
toolbar, caption typography, or desktop frame padding changes.

The showcase holds each screen for 10 seconds, then glides from left to right
over 1.8 seconds. The last-to-first transition follows the same direction without
a rewind. Hovering anywhere in the showcase pauses both the reading time and an
automatic slide already in motion. Leaving resumes it. Manual selections still
work while hovered. Keyboard focus, the local Pause button, offscreen visibility,
hidden tabs, reduced motion, and the site's motion control also stop autoplay.
Reduced motion keeps manual selection instant. Screen selection uses Linty's
accent tint, inactive hover uses the shared hover surface, and keyboard focus
has a separate accent outline. Clicking a screenshot does not open or enlarge it.

`node --test tests/website-product.test.mjs` checks looping, hover timing, rapid
selection, image-loading failures, visibility, motion preferences, and themes.

The example week has 69 dictations and 3,048 words. Word counts come from the
example text; illustrative audio durations and processing times feed the app's
normal estimate calculation (about 52 minutes saved at a 40 wpm typing baseline).
These are demonstration figures, not user outcomes or benchmark claims. Screens
are explicitly labelled as example data. Never capture personal dictations.

`mail-icon.png`, `notes-icon.png`, and `safari-icon.png` are the actual application
icons exported from their installed macOS bundles for accurate product screenshots.
They identify compatible applications; they are not Linty logos or endorsements.

The on-page workflow rotates through Notes, Email, and a code editor. Notes shows
a plain-text checklist; Email preserves greeting, paragraph breaks, and sign-off.
The code editor shows a dictated comment beside prewritten, syntax-highlighted
TypeScript. It does not claim code generation or a code-aware formatting mode.
The app windows are illustrations; their toolbar icons are decorative. Notes and
Email captions explain that formatting uses optional on-device text cleanup for English.

Each example automatically loops through ready, listening, transcribing,
a typewriter reveal, and the completed example, with time to read the result
before sliding to the next app. The app buttons, previous/next arrows, keyboard
arrows, and horizontal touch swipes also switch examples. Inactive slides are
hidden from assistive technology. Manual browsing while paused shows the complete
example; Play restarts its demonstration. Automatic rotation does not move focus
or announce each slide. The three logo bars animate as a waveform while listening;
a small caret follows the appearing text. Both effects pause with playback. Hover
over an app window or keyboard focus pauses it temporarily; leaving resumes from
the same point. The app selectors remain outside the hover-pause area.
The Play/Pause button works with pointer, keyboard, and touch. Explicit Pause
persists after leaving, and explicit Play can resume while hovered or focused.

Playback also pauses while offscreen or in a hidden tab. Reduced-motion settings
and the site's Pause motion control stop autoplay; a visitor can explicitly play
the example. Repeating status text is not a live announcement for screen readers.
When motion is disabled, the waveform stays still and text appears in full.
The typewriter shares the single playback timer; there are no per-letter DOM
elements or background animation timers when playback is suspended.
The workflow remains a labelled illustration with no microphone access or speech
processing.

Run `node --test tests/website-demo.test.mjs` to check repeated playback,
pause/resume timing, visibility, motion preferences, scene rotation, preserved
email line breaks, and input controls.
