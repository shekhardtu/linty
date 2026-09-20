# Quiet paste feedback

Unverified delivery now dismisses the pill without an error, warning toast or success signal. The delivery status remains visible when the customer opens the dictation's Details. Known paste failures retain their copy recovery action.

The native pipeline tests cover quiet unverified delivery, retained diagnostic evidence, no automatic retry, verified completion and failed-delivery recovery. Chromium and WebKit dictation checks cover the toast behavior and pill dismissal in both themes with normal and reduced motion. The History details check covers the retained delivery status, keyboard navigation, narrow layouts and accessibility.

Synthetic fixtures; the screenshots show the retained Details information:

- [Light](details-light.png)
- [Dark](details-dark.png)

These checks exercise presentation and pipeline policy. They do not constitute a new packaged-app recording or cross-application paste test; the native delivery implementation is unchanged.
