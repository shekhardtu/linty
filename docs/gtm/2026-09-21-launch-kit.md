# Linty: launch copy and creative kit

Drafts prepared 21 September 2026 for an organic launch. These are proposed copy and production briefs; they have not been published or sent. Record the actual product behavior before using demonstration claims. Use existing Linty branding and real interface captures. No fabricated reviews, speedups, usage figures, or GitHub stars.

**Use one clear core message.**

> Turn spoken thoughts into text, right where you work.
>
> Free, on-device dictation for your Mac.

Supporting copy:

> Choose your language, hold a key, and speak. Linty transcribes on your Mac and pastes your words into the app you're using. English text cleanup runs locally too and can be turned off.
>
> Free app. Open source. No account or API key.

Primary button: **Download for Mac**. Secondary link: **View on GitHub**. Compatibility line: **Apple Silicon · macOS 14+ · Offline after model setup**. Near the setup explanation, state that speech models download separately and English cleanup adds a further download. Do not bury installation prerequisites in a FAQ.

For developer audiences, test this alternate opening:

> Speak your next prompt.
>
> Use your voice to describe the bug, the feature, or the context. Linty turns it into text on your Mac, ready for the app you work in.

Mention a named editor or terminal only after verifying the demonstrated app/version. Dictation is local; pasting the result into a cloud-connected assistant does not make that assistant local. Do not imply an official integration, sponsorship, or endorsement from an editor vendor.

**Record one useful demonstration and derive the other assets from it.**

| Asset | Content | Production brief |
|---|---|---|
| Main video | One real thought becomes editable text in a real app | 30–45 seconds, readable cursor and output, captions, audible speech, actual elapsed processing; disclose any cut |
| Offline clip | Dictation into a local text editor with network disconnected after setup | One continuous take; demonstrate functionality offline, without presenting this alone as a network-security audit |
| Social preview/banner | Headline, actual recording pill and text result, clear Mac compatibility | 1200 × 630 master; use the existing wordmark, colors, and fonts; add `og:image` when the asset is implemented |
| Square or portrait post | A single workflow with a short caption | 1080 × 1080 or 1080 × 1350; derive from the real recording |
| GitHub GIF/video | Hold → speak → release → paste | Short and readable; place before dense feature and benchmark material |
| Article illustration | A legible app capture supporting the tutorial | Label illustrative data; avoid mock text presented as measured output |

Suggested main-video sequence: show a blank note and the headline for 3 seconds; hold the trigger and dictate a 10–15 second project brief; show release, processing, and actual paste at normal speed; show one small correction if needed; finish with the download URL and supported Mac requirements. If the action takes longer, let the video be longer. A good demo explains the experience rather than hiding its costs.

Synthetic demo speech:

> “The settings window closes before my changes are saved. Please find the save handler, keep the window open if saving fails, and show a clear error message so I can try again.”

This is sample input, not a promised transcript. Record the output that the current release actually produces. Use a local editor for the offline clip so the receiving app does not require a connection.

**Three banner/poster concepts are enough to start.**

| Concept | Headline | Supporting line | Visual and CTA |
|---|---|---|---|
| Workflow | Speak your next prompt. | Free dictation for your Mac. | Actual prompt capture; “Download Linty” |
| Offline | Your Mac can do the listening. | Dictation works offline after setup. | Real local-note result; “Try Linty” |
| Open source | A little less typing. | Free app. Open source. Built for Apple Silicon. | Actual product screen; “Explore Linty on GitHub” |

Use one primary CTA per creative. In download-focused posts, a GitHub link can appear in a follow-up. In engineering posts, link directly to the repository. Avoid feature grids, oversized model diagrams, and claims such as “the only private dictation app.”

**Founder launch post for LinkedIn or a longer social post:**

> We've built Linty: a free, open-source dictation app for Apple Silicon Macs.
>
> Choose your language, hold a key, speak, and release. Your words land in the app you're using. Speech recognition runs on your Mac, and English text cleanup can run locally too.
>
> No account, API key, or subscription. Setup downloads the models; dictation works offline afterward.
>
> We're starting with people who write a lot of prompts, bug reports, and project updates. The attached video shows one real workflow.
>
> Try it: https://linty.ai
>
> Source: https://github.com/shekhardtu/linty
>
> I'd value feedback on the first thing that feels confusing or interrupts your work. If the project is useful to you, a GitHub star is appreciated.

Attach the completed recording before using this draft. Replace “we” with “I” if the maintainer prefers a personal voice.

**Short social post:**

> Speak your next prompt.
>
> Linty is free, open-source dictation for Apple Silicon Macs. Hold a key, speak, release to paste. Works offline after model setup.
>
> Try it: https://linty.ai

Follow-up with a technical angle:

> Linty uses Whisper, Parakeet, and optional S1-mini English cleanup to turn speech into text locally. The app source is MIT-licensed, with upstream model terms documented separately.
>
> Code and methodology: https://github.com/shekhardtu/linty

**Community post draft, subject to that community's current rules:**

> Title: I built Linty, a free local dictation app for Apple Silicon Macs
>
> I'm the maker of Linty. It records while you hold a key, transcribes on your Mac, and pastes at the cursor. English text cleanup is local too and can be switched off.
>
> It needs macOS 14+, an Apple Silicon Mac, Microphone and Accessibility permissions, and an initial model download. There's no account or API key.
>
> Handy, FluidVoice, and other projects already do valuable work here. Linty's focus is a simple Mac workflow: choose a language and let the app prepare the speech model. I'd like to learn where this flow works well and where it gets in your way.
>
> Download and demo: https://linty.ai
>
> Source: https://github.com/shekhardtu/linty
>
> If you try it, which part needs work first: setup, text quality, or getting the words into your app?

Use a community-appropriate version, respond personally, and avoid repeatedly posting the same announcement. Do not post to competitors' support threads as unsolicited promotion.

**Hacker News preparation is a fact sheet, not ready-to-paste commentary.** The founder should write the title, introduction, and replies personally. Prepare to explain the personal motivation, the exact supported Macs, the runnable download, local processing and network boundaries, model attribution, how Linty compares with Handy, and a limitation you want help investigating. Be available for technical discussion. HN asks for runnable products and prohibits generated/AI-edited conversation text and vote solicitation. [Show HN](https://news.ycombinator.com/showhn.html), [HN guidelines](https://news.ycombinator.com/newsguidelines.html).

**Creator outreach draft for the founder to personalize and send:**

> Subject: A free local Mac dictation app for a workflow you cover
>
> Hi [name],
>
> Your piece on [specific relevant workflow] made me think Linty might be useful to your audience. We built a free, open-source Mac dictation app that runs speech recognition and optional English cleanup locally.
>
> Here's a short real demo: [link to the completed recording]. The app runs on Apple Silicon with macOS 14 or later: https://linty.ai.
>
> If you'd like to try it, I'd be happy to help with setup and answer technical questions. An independent assessment, including anything that doesn't work well, would be useful to us.
>
> [Founder name]

Choose a relevant recipient and personalize the reference. This is unpaid outreach, with no promise of affiliate earnings, favorable coverage, or reciprocal promotion. No messages have been sent.

**Use a modest star request after value is clear.** Proposed website/README copy:

> If Linty is useful to you, star the project on GitHub. It helps people discover the work and lets you show your support.

Potential in-app copy for a later product change:

> Enjoying Linty? You can support the project with a star on GitHub.

Actions: **Open GitHub** and **Dismiss**. Show at most once after repeated successful use, keep it out of recording, and remember dismissal locally. Do not claim that starring subscribes the user to release notifications. This trigger and UI are proposals, not existing functionality.

**First blog article draft:**

> A little less typing: introducing Linty for Mac
>
> Sometimes you already know what you want to say. The work is getting it into the text box: describing a bug, explaining a feature, writing an update, or capturing a thought before you lose it.
>
> Linty is a free, open-source dictation app for Apple Silicon Macs. Hold a key, speak, and release. It turns your speech into text on your Mac and pastes the result where you're working.
>
> Start with one ordinary task
>
> You don't need to change your whole workflow to try dictation. Open a note and describe the next thing you need to do. Or explain a bug in plain language before editing the details. Start with a short paragraph, read the result, and make any corrections you need.
>
> Linty keeps a local history so you can find and copy previous transcriptions. Its personal dictionary lets you add recurring names or terms. For English, on-device text cleanup can help organize the output; you can switch it off if you prefer the direct transcription.
>
> What setup involves
>
> Linty supports macOS 14 and later on Apple Silicon. Download the app, move it into Applications, grant Microphone and Accessibility permissions, and choose your dictation language. Linty prepares the appropriate speech model. English setup also prepares the cleanup model.
>
> Those models are separate downloads. You need a connection for setup, and the app checks for updates. After the models are ready, speech recognition and cleanup work offline. No account or API key is required.
>
> What local means
>
> Linty does not upload your recordings or transcripts for speech recognition or cleanup. Your history stays on your Mac. The app you paste into may have its own syncing or cloud processing, so local dictation doesn't change how that app handles text.
>
> Why another dictation app?
>
> There are good alternatives, including Handy, FluidVoice, and paid tools with different workflows and platform support. Linty's focus is a straightforward Mac experience with a free download and open application source. We want to learn whether its everyday choices work for you, and improve the parts that don't.
>
> We build on upstream work including Whisper, Parakeet, FluidAudio, and S1-mini. The repository documents their attribution and the project's current limitations.
>
> Try it on your next paragraph
>
> Download Linty at https://linty.ai. The source is at https://github.com/shekhardtu/linty.
>
> Try one short task and tell us where the experience gets in your way. If you find the project useful, a GitHub star is a welcome way to support it.

Editorial source: [current Linty README](../../README.md), [privacy notice](../../PRIVACY.md), [model notices](../../src-tauri/licenses/MODELS.md). Add the real demonstration near the top before publishing.

**Follow-up articles should answer a real decision.** First, a practical tutorial on dictating a clear bug report or project prompt; measure total completion time including edits if making a speed claim. Second, an honest comparison titled “Choosing free offline dictation for your Mac,” including Apple Dictation, Handy, FluidVoice, OpenWhispr, and Linty. Date the comparison and explain where another option is a better fit. Third, publish the first cohort's findings with permissioned quotations and explicit sample size. Avoid publishing an “everyone loves it” story based on downloads or illustrative dashboard data.
