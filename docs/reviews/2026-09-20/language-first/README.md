# Language-led, on-device dictation

The Language page replaces Speech engine settings. Selecting a language prepares its local model during onboarding and later changes. Downloads are reused; failed preparation can be retried; activation waits for dictation to finish.

Speech recognition and optional cleanup run on the Mac. Retired preferences and credentials are deleted on upgrade. Existing transcripts and their original metadata remain available.

Screenshots use synthetic data and the mocked native bridge in Playwright WebKit at 1080 × 820. No personal history or audio is included. The website screenshots are separately reproduced with `scripts/capture-website.mjs` at 1200 × 800 and 2× scale.

![Language settings in the light theme](light.png)

![Language settings in the dark theme](dark.png)

The landing page uses English in its Language screenshots and describes automatic
speech preparation, offline dictation, and optional on-device English cleanup.
The following Chrome captures show the updated website carousel. Desktop and
390px mobile layouts, theme switching, and the new setup FAQs were checked.

![Website Language preview in the light theme](website-light.png)

![Website Language preview in the dark theme](website-dark.png)
