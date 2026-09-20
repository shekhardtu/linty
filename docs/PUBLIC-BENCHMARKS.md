# Public speech benchmarks

Linty's public corpus suite downloads public English test data, evaluates the
production Parakeet TDT v3 and Whisper Large v3 Turbo Q5 transcription paths, and
generates corpus scores, clip CSVs, and a Markdown table from the raw outputs.

The full supported English splits contain 2,620 LibriSpeech test-clean clips,
2,939 LibriSpeech test-other clips, and 647 FLEURS en_us/test clips. Prepared data
and local runs stay under ignored artifacts/. Only completed, validated runs can
be exported for publication.

## Scope and comparison with Wispr

These are direct-file speech-engine measurements on one Mac, with production
speech-presence guards enabled, English explicitly selected, and no vocabulary
prompt, personal dictionary, text cleanup, or network call. Each engine is loaded
once per dataset and processes one recording at a time. Each recording receives
one inference; no best-of-repeat output selection is performed.

The suite excludes microphone capture, the frontend, clipboard insertion, and
editing time. Read speech does not establish performance on spontaneous dictation,
Indian English, code switching, corrections, or a particular microphone. Use the
[dictation evaluation](DICTATION-EVALUATION.md) for cleanup semantics and separate
live-app tests for stop-to-paste latency.

Wispr's [September 17, 2026 Canto report](https://wisprflow.ai/canto) names
LibriSpeech, FLEURS, and Common Voice and reports English WER without contextual
prompting. It does not identify the exact public test splits, Common Voice
release, sample manifest, or scoring normalizer. **Sharing dataset names does
not make this an exact reproduction of Canto's evaluation.** Do not make a
head-to-head claim without matching those details or rerunning both products
on the same clips and scorer. Wispr's private datasets are not part of this suite.

## Install

Use **Python 3.12 or newer**. Native inference also requires Linty's usual macOS
Apple Silicon, Xcode, and Rust build environment, with both speech models already
installed in Linty. Commands assume that python3 selects a supported version.
From the repository root:

~~~sh
python3 -m venv artifacts/public-benchmark-venv
artifacts/public-benchmark-venv/bin/python -m pip install \
  -r scripts/benchmarks/public-requirements.txt
~~~

Audio and environments stay under ignored artifacts/. Nothing reads microphone
recordings, History, clipboard data, credentials, or personal dictionaries.
Only prepare downloads public data; run uses installed models. A Cargo build may
fetch ordinary build dependencies.

## Prepare complete test splits

~~~sh
artifacts/public-benchmark-venv/bin/python scripts/benchmarks/public_corpus.py \
  prepare librispeech-test-clean artifacts/public-corpus/librispeech-test-clean

artifacts/public-benchmark-venv/bin/python scripts/benchmarks/public_corpus.py \
  prepare librispeech-test-other artifacts/public-corpus/librispeech-test-other

artifacts/public-benchmark-venv/bin/python scripts/benchmarks/public_corpus.py \
  prepare fleurs-en_us-test artifacts/public-corpus/fleurs-en_us-test
~~~

Compressed downloads total about 1 GB. Allow several GB for WAVs, cached archives,
the Python environment, and reports, plus the native build. Cached archives are
verified before reuse; interrupted downloads are discarded. Archive contents are
read directly, not extracted into arbitrary filesystem paths. Existing corpus,
run, and publication directories are never silently overwritten.

Add --limit 100 and a distinct output directory for a smoke evaluation. Selection
uses ascending SHA-256 of seed:recording_id, with default seed 20260919. The
manifest stores available and selected counts. An omitted limit selects the full
test split. Samples are explicitly labelled in generated tables.

Audio is downmixed using the arithmetic channel mean, resampled with SciPy's
resample_poly if necessary, and written as 16 kHz mono signed 16-bit PCM WAV.
There is no volume normalization, silence trimming, or denoising. Manifests record
source URLs, archive checksums, original recording checksums, converted WAV
checksums, durations, references, and conversion package versions. FLEURS uses
unique recording filenames; sentence IDs repeat across recordings.

### Common Voice

Obtain an **English** release through
[Mozilla's official data platform](https://www.mozillafoundation.org/en/common-voice/)
under its access and usage terms, then supply the release version and source URL:

~~~sh
artifacts/public-benchmark-venv/bin/python scripts/benchmarks/public_corpus.py \
  prepare common-voice-en-test artifacts/public-corpus/common-voice-en-test \
  --source-dir /path/to/release/en \
  --version RELEASE_VERSION \
  --source-url OFFICIAL_RELEASE_PAGE_URL
~~~

The directory must contain test.tsv and clips/. The loader records TSV and
recording hashes but does not copy contributor client_id fields into publications.
No Common Voice release is assumed to match Wispr's unspecified one.

## Run both production engines

Build once, before timing any inference:

~~~sh
cargo build --release --locked --manifest-path src-tauri/Cargo.toml \
  --example corpus_eval --features local-stt,parakeet

for engine in parakeet whisper; do
  for dataset in fleurs-en_us-test librispeech-test-clean librispeech-test-other; do
    artifacts/public-benchmark-venv/bin/python scripts/benchmarks/public_corpus.py \
      run "$engine" "artifacts/public-corpus/$dataset/manifest.json" \
      "artifacts/public-corpus/runs/$dataset-$engine" --skip-build
  done
done
~~~

Without --skip-build, run builds the release binary first. --models overrides
the standard Linty model directory. --timeout sets a whole-run time limit
(default three hours). Run engines sequentially and avoid simultaneous compilation
or other benchmarks. Ordinary desktop load can affect timing; hardware, macOS,
power, and thermal observations are recorded.

Each result is flushed to results.jsonl when its clip finishes. A missing or corrupt
WAV, checksum mismatch, or decoder error stays a failed case. A process failure or
timeout preserves partial output, but the scorer rejects that run for publication.
There is no silent skipping or automatic best-result retry.

## Scoring and timing

- **WER** = (substitutions + deletions + insertions) / reference words, summed
  across the selected corpus. It is not mean per-clip WER and can exceed 100%.
- **CER** uses the same corpus aggregation on normalized Unicode characters,
  including internal spaces.
- Both sides pass through the pinned
  [EnglishTextNormalizer](https://github.com/kurianbenoy/whisper_normalizer).
  First, the same spoken-english-v1 preprocessing straightens curly apostrophes
  and replaces round-parenthesis delimiters with spaces, preserving the spoken
  words inside. Unmodified Whisper normalization would discard entire spoken
  parentheticals in FLEURS references. Raw reference text is retained unchanged.
  It handles punctuation, casing, contractions, numbers, and English spelling
  conventions. [JiWER](https://github.com/jitsi/jiwer) computes edit counts.
  These recognition metrics do not score punctuation or formatting quality.
  Original and normalized text are both preserved.
- Failed cases use an empty hypothesis, counting reference words as deletions;
  failure counts remain visible. Successful empty transcripts are counted
  separately. Empty-reference-only corpora have undefined WER/CER (null).
- **Inference p50/p95** use linear interpolation over successful production
  transcription calls after the first clip. They exclude WAV reading, hashing,
  model loading, and explicit Whisper warmup. First-clip inference, loading, and
  warmup times are retained separately.
- **Throughput** is successful audio duration divided by successful inference
  time, including the first clip. It is not stop-to-paste latency. Model
  preparation follows production behavior: Parakeet prepares during load and
  Whisper also runs its production warmup. OS caches are not purged.

Results remain separate by dataset and engine. The suite does not infer a blended
competitor ranking, confidence interval, memory/power estimate, or whole-app
accuracy percentage from these measurements.

## Re-score and publish

Regenerate one run's scored.json and clips.csv:

~~~sh
artifacts/public-benchmark-venv/bin/python scripts/benchmarks/public_corpus.py \
  score artifacts/public-corpus/runs/fleurs-en_us-test-parakeet
~~~

For a future export, supply only completed runs. The command below assumes all
six runs have finished; for a Parakeet-only export, omit the three Whisper paths:

~~~sh
artifacts/public-benchmark-venv/bin/python scripts/benchmarks/public_corpus.py \
  publish docs/benchmarks/public-corpus-YYYY-MM-DD \
  artifacts/public-corpus/runs/fleurs-en_us-test-parakeet \
  artifacts/public-corpus/runs/fleurs-en_us-test-whisper \
  artifacts/public-corpus/runs/librispeech-test-clean-parakeet \
  artifacts/public-corpus/runs/librispeech-test-clean-whisper \
  artifacts/public-corpus/runs/librispeech-test-other-parakeet \
  artifacts/public-corpus/runs/librispeech-test-other-whisper
~~~

This writes local files for review; it does not commit or push. Publication
recomputes every score from raw output, checks completeness and manifest identities,
rejects comparisons with different clips or normalizers, and exports evidence.
README editing is optional. To opt in, add exactly one pair of the following
markers to the desired README and
pass --readme README.md to publish:

~~~html
<!-- public-benchmarks:start -->
<!-- public-benchmarks:end -->
~~~

Only that marker block is replaced. Update any surrounding date, hardware
description, and evidence link when changing the run.
Runs with different hardware, operating systems, native binaries, or versions of
the same model must be published separately.

Each exported run contains:

- **manifest.json:** attributed version, exact selection, references, hashes.
- **results.jsonl:** native settings, preparation, raw outputs, errors.
- **run.json:** timestamps, binary/model/source hashes, Git state, package
  versions, hardware, and environment. Dirty checkouts are explicitly recorded.
- **scored.json and clips.csv:** aggregate and per-recording measurements.

The publication's summary.json and README.md provide generated overviews. Audio
and models are not included in Git. Re-download the attributed data for inference;
rescoring exported transcripts requires neither a Mac nor audio/models. Hashes
document the inputs and build, but do not prove independently audited results.
Source changes during a run are recorded; the binary hash identifies the executable.

## Tests

~~~sh
artifacts/public-benchmark-venv/bin/python -m unittest discover \
  -s tests -p public_corpus_test.py -v
~~~

CI runs offline fixture tests without models, network datasets, or Apple hardware.
They cover aggregation, normalization, failures, incomplete/mismatched results,
deterministic selection, dataset adapters, and audio conversion.

## Dataset attribution

- **LibriSpeech ASR corpus**, Vassil Panayotov, Guoguo Chen, Daniel Povey, and
  Sanjeev Khudanpur; [OpenSLR SLR12](https://www.openslr.org/12), CC BY 4.0.
  References and audio are converted for evaluation, with original references
  retained. Archive MD5s are verified against the
  [upstream list](https://www.openslr.org/resources/12/md5sum.txt); SHA-256 is
  also recorded.
- **FLEURS**, Alexis Conneau and colleagues;
  [dataset](https://huggingface.co/datasets/google/fleurs) and
  [paper](https://arxiv.org/abs/2205.12446), CC BY 4.0. English test audio and TSV
  are pinned to revision 70bb2e84b976b7e960aa89f1c648e09c59f894dd and SHA-256
  verified. Transformations are described above.
- **Common Voice**, Mozilla and contributors: cite the exact release page,
  version, and terms supplied during import.
