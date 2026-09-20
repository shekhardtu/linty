# Dictation evaluation

The product should let people speak naturally and produce the message they
settled on. Evaluate three things together: remove verbal clutter, repair grammar
where needed, and resolve clear restarts or corrections. Preserve facts,
politeness, uncertainty, negation, conditions, and independent requests.

The [38-case corpus](../tests/fixtures/dictation-challenges.json) includes positive
cases and counterexamples. Replacing every `R` with `our`, deleting every `like`,
or always retaining only the last number would fail it. Quoted demonstrations of
mistakes must remain understandable as demonstrations. Ambiguous cases need
human review; fluency alone is not success.

## Initial baseline: September 19, 2026

The [saved 38-case report](benchmarks/dictation-evaluation-s1-2026-09-19.json)
contains every input, output, measurement, automatic assessment, and Codex text
review. All cases ran locally through S1-mini Q4_K_M on Metal with the published
system prompt. No candidate general instruction was used.

Automatic screening found 24 reference matches, nine outputs needing review,
four content-constraint failures, and one fallback. After reviewing every input
and output, Codex assessed 27 as acceptable, 10 as needing fixes, and one as
requiring a recording to judge deliberate emphasis. This is assistant review of
a small scripted text corpus, not independent human evaluation or product
accuracy. One accepted output lacks a terminal period.

Concrete failures include:

- Grammar: `Why does our cleanup is so superficial?` remains uncorrected.
- Spelling: `our, O U R` becomes `our O-U-R` instead of consuming the aside.
- Corrections: `send now, no, don't send until I review` retains both directions.
- Numbers: one lakh fifty thousand rupees becomes ₹1,050,000 instead of ₹150,000.
- Integration: S1 returns empty text for `um uh um`, but the output guard rejects
  it and restores the fillers. This implementation defect is fixed below.

Simple amount/day/recipient corrections, a long message containing two
corrections, most preservation cases, and the spoken email address worked in this
run. The suite distinguishes these successes from the failures.

The runner's audio handling was separately checked with generated digital
silence, a missing recording, an invalid WAV, and a too-short WAV. It correctly
kept those as no speech, pending audio, audio error, and transcription error;
none was substituted with reference text. These are harness checks, not human
voice tests. All 89 JavaScript tests passed, including the six evaluation tests.

## Filler-only result fix

The native validator now accepts empty S1 output only for chunks containing
recognizable `um`/`uh` fillers and ordinary speech punctuation. It still rejects
empty output for meaningful words, quoted content, initials, numbers, symbols,
or unknown content. The published S1 prompt is unchanged.

When a whole dictation cleans to nothing, the frontend finishes quietly before
dictionary, clipboard, paste, and History operations. It discards the pending
audio for that recording and remains ready for the next dictation. Empty chunks
within a longer completed result contribute no extra blank paragraphs. These
changes address the filler-only defect; the initial model-quality findings
remain separate.

The [38-case rerun](benchmarks/dictation-evaluation-s1-filler-fix-2026-09-19.json)
changes only `33-filler-only`: it now returns an accepted empty result with
`reason: filler_only`. All other 37 output strings are identical to the initial
baseline. Automatic reference matches increase from 24 to 25, with nine still
needing review and four still failing content constraints.

Validation also passes all 94 JavaScript tests, 96 standard native tests, all
nine targeted reformat tests including the installed-model tests, the frontend
build, and `yarn test:cleanup`. The UI regression confirms no clipboard/paste or
History write for filler-only results, disposal of pending audio, normal delivery
of the next `No` dictation, and preservation of meaningful text on fallback.

## First recording session: eight short dictations

Use Linty in an empty note, with English and on-device cleanup selected. Dictate
each row separately, in your normal voice. Do not read the ID or expected result
aloud. Leave the pasted results untouched for the first comparison. Linty's
History already keeps the speech engine output and cleanup output separately.
Once these eight are done, we can compare those snapshots without requiring you
to export audio. Replaying saved WAVs is a separate workflow described below.

| ID | Say this | Expected meaning |
| --- | --- | --- |
| 01 | Um, could you, uh, send me the report please? | Could you send me the report, please? |
| 05 | Why does our cleanup is so superficial? | Why is our cleanup so superficial? |
| 07 | Could you get me ten thousand—no, get me five thousand rupees? | One request for 5,000 rupees. |
| 13 | Why is R—I mean our, O, U, R—cleanup so superficial? | Why is our cleanup so superficial? |
| 17 | I am programming in R, and our team also uses Python. | Retain both R and our in their correct places. |
| 20 | The example sentence is quote send it Friday no Monday end quote. | Preserve both days inside the example. |
| 22 | I think this might work, but I'm not sure. | Keep the uncertainty. |
| 31 | Send the report to Priya on Friday—actually Monday—and keep the budget unchanged. | Correct the day, retain Priya and the budget instruction. |

For 07, pause briefly before correcting the amount. For 13, pronounce O, U, and
R as separate letters. For 20, say “quote” and “end quote” aloud. Use your ordinary
accent; clear, exaggerated pronunciation is not required.

After the first session, repeat the same eight with a longer correction pause,
then at your usual fast speaking pace. Keep each take identifiable by case and
delivery. Later sessions cover the other cases, natural unscripted speech,
long dictations, quiet speech, and ordinary background noise. Text-only results
cannot establish performance on accent, pauses, microphone conditions, or noise.

## Reproducible local runs

From the repository root, using models already installed by Linty:

```sh
cargo run --release --manifest-path src-tauri/Cargo.toml \
  --example dictation_eval --features local-stt,parakeet -- \
  "$HOME/Library/Application Support/ai.linty.desktop/models" \
  tests/fixtures/dictation-challenges.json artifacts/dictation-eval/s1.json

node scripts/benchmarks/score-dictation.mjs \
  tests/fixtures/dictation-challenges.json artifacts/dictation-eval/s1.json \
  artifacts/dictation-eval/s1-scored.json
```

This runs every reference transcript through the production S1 inference path,
preparing the model once. It does not exercise speech recognition, dictionary
replacements, the UI, or paste. The report records the corpus hash, model/runtime
metadata, selected options, complete input/output, status, and per-case timing.
Preparation is reported separately. One run per case is a diagnostic sample,
not a latency percentile or reliability estimate.

For repeatable audio evaluation, save each recording as `CASE_ID.wav`, for
example `07-amount-correction.wav`, and pass the containing directory as the
fourth argument after the report path. WAVs must be 16 kHz, mono, 16-bit PCM.
Convert a recording if needed:

```sh
afconvert -f WAVE -d LEI16@16000 -c 1 recording.m4a \
  artifacts/dictation-eval/audio/07-amount-correction.wav
```

Audio mode runs the actual Parakeet transcription path followed by S1, with
English selected and the personal dictionary disabled to isolate the models.
It records each WAV's hash, duration, raw transcript, and cleaned text. Missing
files stay `pending-audio`; invalid files and speech-engine errors remain errors.
There is no substitution of scripted text for missing recordings. This is a
model-pipeline evaluation, not a full UI/paste test. No models are downloaded,
app settings altered, or transcripts inserted into History by the runner.

## Reading the results

- `reference-match`: matches a listed acceptable output, allowing only
  whitespace and typographic quote differences. Still review meaning.
- `needs-review`: differs from the listed outputs; may be a valid paraphrase or
  a missed correction. This is not automatically a failure.
- `constraint-failure`: a named required detail is missing, or a superseded
  detail remains. Inspect the actual output to confirm the semantic failure.
- `runtime-error`: cleanup failed/skipped or audio/transcription failed.
- `pending-audio`: a recording has not been supplied.

Lexical checks are screening signals. They do not prove that amounts belong to
the right person or that every sentence retains its meaning. Do not publish the
reference-match fraction as product accuracy. Human review should record a
verdict, failure stage (recognition, cleanup, delivery), and explanation. Never
relax an expected meaning simply to make the current model pass.

For an audio mismatch, compare the recorded speech to `rawText` first. If the raw
transcript lost an explicit correction, that is a speech-recognition issue. If
the raw transcript contains the evidence but the final text is wrong, investigate
cleanup. Preserve both failures if both stages contributed.

## Instructions and release decisions

S1 uses the publisher's fixed system prompt, control line, disabled thinking,
and greedy decoding in `src-tauri/src/reformat.rs`. Arbitrary instructions are
not a supported steering mechanism. See the
[publisher's input requirements](https://huggingface.co/superwhisper/s1-mini#the-control-line).

The [candidate instruction](dictation-cleanup-instruction.txt) states the three
intended behaviors, spelling clarification, preservation rules, and examples.
It is an unevaluated draft for a future instruction-following local model. It is
not installed as S1's prompt, and this work does not change either production
cleanup prompt. The evaluation stays fully local. A S1 baseline does not evaluate
the candidate instruction.

Before choosing a replacement or shipping a quality claim, compare identical
cases, model settings, and complete original transcripts. Verify unexpected S1
failures in a reference runtime with the same weights and input format before
attributing all failures to the weights. Compare any new prompt against its
previous version using the same instruction-following model, then test recordings
and unscripted speech. No success claim should hide unresolved meaning changes.

Run the evaluation harness tests with:

```sh
node --experimental-strip-types --test \
  tests/dictation-evaluation.test.mjs tests/correction-service.test.mjs
```
