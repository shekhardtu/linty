# Linty icon identity

Linty uses one three-stroke voice mark, drawn in
[`src/assets/linty-mark.svg`](../src/assets/linty-mark.svg). The same geometry
appears in the app, native menu bar and packaged application.

| Surface | Source / output |
| --- | --- |
| Sidebar, selected navigation, setup header, appearance specimen | `BrandMark` masks the canonical SVG with the theme accent |
| About and onboarding welcome | `public/brand/icon.svg`, the packaged app design |
| Finder, Dock, Launchpad, native About, and app in the installer | `src-tauri/icons/icon.icns`, with multiple resolutions |
| PNG / Windows icon consumers | Generated `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, `icon.ico` |
| Native menu bar | Generated transparent black template at 22 px and 44 px; `iconAsTemplate: true` lets macOS tint it |
| Linty in History and Apps | The current build's embedded PNG, keyed by the configured bundle identifier, avoiding an older installed app's icon |
| Browser favicon and pinned shortcut | `public/brand/` SVG, PNG and touch icon |
| Website header, footer and favicon | Generated `website/brand/` assets |
| Website on-device and shortcut indicators | `website/brand/cpu.svg` and `command.svg`, generated from the app's Lucide components; dependency version tracked through `yarn.lock` |
| Website colors, type and controls | `website/brand/theme.css`, generated from `src/styles/tokens.css`; follows the system light/dark preference |
| App and website voice patterns | `src/assets/brand-artwork.json`; app components render it directly, website `flow.svg` and `contour.svg` are generated |
| Repository README | Existing link to the regenerated `src-tauri/icons/icon.png` |

The full app icon places the mark in white on a teal macOS-style silhouette,
with transparent outer padding. Bare marks use the same proportions; they
inherit the interface accent or native menu bar color. Functional microphone,
engine and status icons keep their distinct meanings.

The landing page also uses the packaged icon near its download link. Its teal
accents, native typography, short heading rules and subtle mineral wash match
the application. The icon's fixed teal comes from `--palette-light-accent`;
the website's bare marks adapt to the theme accent. Typography tokens live in
the same application token file, so neither surface maintains its own stack.

## Updating the icon

1. Edit the canonical mark, artwork geometry, or `src/styles/tokens.css`. The app icon's silhouette
   and placement are defined once in `scripts/generate-icons.mjs`.
2. Run `yarn icons:generate`. The existing Tauri CLI renders the platform formats;
   only assets used by the application are retained.
3. Run `yarn icons:check` and `yarn build`.

`src-tauri/icons/manifest.json` records source and generated-output hashes.
The regular frontend build checks them, including builds initiated by Tauri and
release CI. A hand-edited or stale generated icon fails with a regeneration
instruction. Never maintain an independent tray drawing or CSS bar geometry.

The bundle configuration points to the generated icon files. Previously
installed app bundles, downloaded DMGs and already-published website assets
receive the new identity when rebuilt/released; editing their signed resources
in place would invalidate the existing signatures.

Platform references: [Tauri icon formats](https://v2.tauri.app/develop/icons/)
and [AppKit template images](https://developer.apple.com/documentation/appkit/nsimage/istemplate).

## Verification

- Decoded the ICNS into its ten standard representations (16–1024 px) and
  inspected the full-size and small icons; checked the ICO's six sizes.
- Verified both tray PNGs contain only black RGB values with alpha transparency.
- Ran Chromium and WebKit interface checks in both themes, including onboarding;
  verified the website's header/footer and favicon asset paths.
- Built the native application and ran all 36 native tests.
- Built local app/DMG validation bundles with signing disabled, mounted the DMG
  read-only, and verified that the installed app's ICNS and volume icon both
  match the generated ICNS byte for byte. This was a local packaging check,
  not a published release.
