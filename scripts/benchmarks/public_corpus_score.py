"""Corpus-weighted scoring and Markdown generated only from verified reports."""
import csv
import importlib.metadata
import json
import math
from pathlib import Path

from public_corpus_data import digest, write_json


def normalize_spoken(text, normalizer):
    # FLEURS raw references contain spoken parentheticals. Whisper's normalizer
    # treats them as annotations and otherwise drops the words. Apply the same
    # typography-only preprocessing to both reference and hypothesis.
    return normalizer(text.translate(str.maketrans({"(": " ", ")": " ", "‘": "'", "’": "'"}))).strip()


def percentile(values, fraction):
    if not values:
        return None
    values = sorted(values)
    index = (len(values) - 1) * fraction
    low, high = math.floor(index), math.ceil(index)
    return values[low] + (values[high] - values[low]) * (index - low)


def read_events(path):
    events = []
    for line in Path(path).read_text().splitlines():
        if line.strip():
            events.append(json.loads(line))
    return events


def score(manifest_path, results_path, output):
    import jiwer
    from whisper_normalizer.english import EnglishTextNormalizer

    manifest = json.loads(Path(manifest_path).read_text())
    if manifest.get("schema_version") != 1 or manifest.get("language") != "en":
        raise ValueError("Expected an English v1 manifest")
    cases = manifest["cases"]
    ids = [case["id"] for case in cases]
    if not cases or len(ids) != len(set(ids)):
        raise ValueError("Empty corpus or duplicate manifest IDs")
    selection = manifest["selection"]
    available = selection.get("available_cases")
    if not isinstance(available, int) or available < len(cases) or selection.get("selected_cases") != len(cases):
        raise ValueError("Manifest selection counts do not match cases")
    expected_scope = "full-test-split" if available == len(cases) else "deterministic-sample"
    if selection.get("scope") != expected_scope:
        raise ValueError("Manifest mislabels sample coverage")
    events = read_events(results_path)
    if not events or events[0].get("type") != "start" or events[-1].get("type") != "complete":
        raise ValueError("Incomplete run: start/completion record missing; cannot publish")
    header, end = events[0], events[-1]
    if header.get("manifest_sha256") != digest(manifest_path):
        raise ValueError("Manifest checksum does not match run")
    if header.get("schema_version") != 1 or header.get("engine") not in ("whisper", "parakeet"):
        raise ValueError("Invalid run schema or engine")
    if header.get("profile") != "release" or header.get("language") != "en" or any(
        header.get(key) is not False for key in ("cleanup", "dictionary", "context_prompt")
    ) or header.get("production_speech_guards") is not True:
        raise ValueError("Run does not use the public benchmark settings")
    rows = [event for event in events if event.get("type") == "case"]
    ready = [event for event in events if event.get("type") == "ready"]
    if len(ready) != 1 or len(events) != len(rows) + 3:
        raise ValueError("Unexpected or duplicated run events")
    if len(rows) != len(cases) or header.get("expected_cases") != len(cases) or end.get("cases") != len(cases):
        raise ValueError("Incomplete run: clip counts differ")
    if [row["id"] for row in rows] != ids:
        raise ValueError("Run IDs/order differ from the manifest")
    if end.get("errors") != sum(row.get("error") is not None for row in rows):
        raise ValueError("Incorrect error count")
    normalizer = EnglishTextNormalizer()
    totals = dict(hits=0, substitutions=0, deletions=0, insertions=0, reference_words=0,
                  character_errors=0, reference_characters=0, failed_clips=0, empty_outputs=0)
    scored = []
    timing = []
    successful_audio = 0.0
    successful_time = 0.0
    for index, (case, row) in enumerate(zip(cases, rows)):
        if row.get("sequence") != index or row.get("audio_sha256") != case["audio_sha256"]:
            raise ValueError(f"Clip identity mismatch: {case['id']}")
        if not isinstance(row.get("text"), str) or not isinstance(case.get("reference"), str):
            raise ValueError("Transcript/reference must be strings")
        if not math.isfinite(case["audio_seconds"]) or case["audio_seconds"] <= 0:
            raise ValueError("Invalid manifest audio duration")
        failed = row.get("error") is not None
        # Failed clips count as empty hypotheses: their reference words become deletions.
        reference = normalize_spoken(case["reference"], normalizer)
        hypothesis = normalize_spoken(row["text"], normalizer) if not failed else ""
        words = jiwer.process_words(reference, hypothesis)
        chars = jiwer.process_characters(reference, hypothesis)
        reference_words = len(reference.split())
        word_errors = words.substitutions + words.deletions + words.insertions
        character_errors = chars.substitutions + chars.deletions + chars.insertions
        for field in ("hits", "substitutions", "deletions", "insertions"):
            totals[field] += getattr(words, field)
        totals["reference_words"] += reference_words
        totals["reference_characters"] += len(reference)
        totals["character_errors"] += character_errors
        totals["failed_clips"] += failed
        totals["empty_outputs"] += not row["text"].strip() and not failed
        seconds = row.get("inference_seconds")
        if not failed:
            if not isinstance(seconds, (float, int)) or not math.isfinite(seconds) or seconds <= 0:
                raise ValueError("Successful clip has invalid timing")
            if not isinstance(row.get("audio_seconds"), (float, int)) or abs(row["audio_seconds"] - case["audio_seconds"]) > 1 / 16000:
                raise ValueError("Audio duration mismatch")
            successful_audio += case["audio_seconds"]
            successful_time += seconds
            if index > 0:
                timing.append(seconds)
        scored.append({"id": case["id"], "reference": case["reference"], "hypothesis": row["text"],
                       "normalized_reference": reference, "normalized_hypothesis": hypothesis,
                       "reference_words": reference_words, "substitutions": words.substitutions,
                       "deletions": words.deletions, "insertions": words.insertions,
                       "word_errors": word_errors, "wer": word_errors / reference_words if reference_words else None,
                       "character_errors": character_errors, "reference_characters": len(reference),
                       "error": row.get("error"), "audio_seconds": case["audio_seconds"], "inference_seconds": seconds})
    errors = totals["substitutions"] + totals["deletions"] + totals["insertions"]
    summary = {**totals, "clips": len(cases), "audio_hours": sum(case["audio_seconds"] for case in cases) / 3600,
               "wer": errors / totals["reference_words"] if totals["reference_words"] else None,
               "cer": totals["character_errors"] / totals["reference_characters"] if totals["reference_characters"] else None,
               "inference_p50_seconds": percentile(timing, .5), "inference_p95_seconds": percentile(timing, .95),
               "timed_clips_excluding_first": len(timing), "first_clip_inference_seconds": rows[0].get("inference_seconds"),
               "successful_audio_seconds": successful_audio, "successful_inference_seconds": successful_time,
               "real_time_factor": successful_time / successful_audio if successful_audio else None,
               "audio_speedup": successful_audio / successful_time if successful_time else None}
    report = {"schema_version": 1, "engine": header["engine"], "dataset_id": manifest["dataset_id"],
              "dataset": manifest["dataset"], "selection": manifest["selection"],
              "manifest_sha256": digest(manifest_path), "results_sha256": digest(results_path),
              "normalization": {"name": "whisper_normalizer.english.EnglishTextNormalizer",
                                "preprocessing": "spoken-english-v1: replace round-parenthesis delimiters with spaces; straighten left/right curly apostrophes; identical on both sides",
                                "version": importlib.metadata.version("whisper-normalizer"),
                                "scorer": "jiwer", "scorer_version": importlib.metadata.version("jiwer")},
              "scoring_source_sha256": digest(Path(__file__)),
              "policy": {"aggregation": "sum edit counts / sum reference lengths; never mean per-clip WER",
                         "failures": "empty hypothesis, counted as deletions; separately reported",
                         "cer": "normalized Unicode characters including internal spaces",
                         "timing": "production transcription call, successful clips; p50/p95 exclude first clip; loading and audio decoding excluded",
                         "comparison": "not an exact replication of Wispr Canto's undisclosed splits/normalization"},
              "settings": header, "preparation": ready[0], "summary": summary, "cases": scored}
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "scored.json", report)
    with (output / "clips.csv").open("w", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=list(scored[0]))
        writer.writeheader()
        writer.writerows(scored)
    return report


def markdown(reports):
    if not reports:
        raise ValueError("No reports")
    by_dataset = {}
    seen = set()
    normalizations = set()
    for report in reports:
        identity = (report["dataset_id"], report["engine"])
        if identity in seen:
            raise ValueError("Duplicate dataset/engine report")
        seen.add(identity)
        normalizations.add(json.dumps(report["normalization"], sort_keys=True))
        previous = by_dataset.setdefault(report["dataset_id"], report["manifest_sha256"])
        if previous != report["manifest_sha256"]:
            raise ValueError("Cannot compare engines on different selected clips")
    if len(normalizations) != 1:
        raise ValueError("Cannot compare different normalizers/scorers")

    def number(value, multiplier=1, suffix=""):
        return "—" if value is None else f"{value * multiplier:.2f}{suffix}"

    lines = ["| Dataset / split | Coverage | Engine | Clips | WER ↓ | CER ↓ | Failures | Inference p50 / p95 | Throughput |",
             "|---|---|---|---:|---:|---:|---:|---:|---:|"]
    for report in sorted(reports, key=lambda row: (row["dataset_id"], row["engine"])):
        data, stats = report["dataset"], report["summary"]
        label = "Parakeet TDT v3" if report["engine"] == "parakeet" else "Whisper Turbo Q5"
        coverage = "Full test split" if report["selection"]["scope"] == "full-test-split" else f"Sample of {report['selection']['available_cases']:,}"
        lines.append(f"| {data['name']} {data['config']} / {data['split']} | {coverage} | {label} | {stats['clips']:,} | "
                     f"{number(stats['wer'], 100, '%')} | {number(stats['cer'], 100, '%')} | {stats['failed_clips']} | "
                     f"{number(stats['inference_p50_seconds'])} / {number(stats['inference_p95_seconds'], suffix=' s')} | "
                     f"{number(stats['audio_speedup'], suffix='×')} |")
    lines.extend(["", "WER and CER are corpus-weighted after English text normalization; lower is better. Failed clips count as deletions. "
                  "Inference p50/p95 exclude the first clip and model loading; throughput is audio duration divided by inference time. "
                  "These are direct-file production-engine measurements, excluding microphone capture, cleanup, UI, and paste.", ""])
    return "\n".join(lines)
