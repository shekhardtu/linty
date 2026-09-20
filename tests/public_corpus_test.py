"""Offline regression tests for publication integrity and dataset adapters."""
import copy
import argparse
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/benchmarks"))
from public_corpus_data import common_voice_rows, convert_audio, digest, download, fleurs_rows, prepare, select_cases, write_json
from public_corpus_score import markdown, percentile, score
from public_corpus import publish


class CorpusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = {"schema_version": 1, "dataset_id": "fixture", "language": "en",
                         "dataset": {"name": "Fixture", "config": "en", "split": "test"},
                         "selection": {"scope": "full-test-split", "available_cases": 2}, "cases": []}
        self.events = []

    def fixture(self, pairs, errors=None):
        errors = errors or [None] * len(pairs)
        self.manifest["selection"].update(available_cases=len(pairs), selected_cases=len(pairs))
        self.manifest["cases"] = [{"id": str(index), "reference": reference, "audio_sha256": f"hash{index}",
                                   "audio_seconds": 2.0} for index, (reference, _) in enumerate(pairs)]
        write_json(self.root / "manifest.json", self.manifest)
        self.events = [{"type": "start", "schema_version": 1, "engine": "whisper", "expected_cases": len(pairs),
                        "manifest_sha256": digest(self.root / "manifest.json"), "profile": "release", "language": "en",
                        "cleanup": False, "dictionary": False, "context_prompt": False, "production_speech_guards": True},
                       {"type": "ready", "model_load_seconds": .5}]
        for index, (_, hypothesis) in enumerate(pairs):
            self.events.append({"type": "case", "id": str(index), "audio_sha256": f"hash{index}", "text": hypothesis,
                                "error": errors[index], "sequence": index, "audio_seconds": 2.0,
                                "inference_seconds": .1 * (index + 1)})
        self.events.append({"type": "complete", "cases": len(pairs), "errors": sum(error is not None for error in errors)})

    def evaluate(self):
        (self.root / "results.jsonl").write_text("".join(json.dumps(event) + "\n" for event in self.events))
        return score(self.root / "manifest.json", self.root / "results.jsonl", self.root / "scored")

    def test_corpus_weighting_is_not_average_clip_wer(self):
        self.fixture([("cat", "dog"), ("a b c d e f g h i j", "a b c d e f g h i j")])
        result = self.evaluate()["summary"]
        self.assertAlmostEqual(result["wer"], 1 / 11)
        self.assertEqual(result["substitutions"], 1)

    def test_normalization_contractions_numbers_and_punctuation(self):
        self.fixture([("I'm paying twenty dollars.", "I am paying $20"), ("HELLO, WORLD!", "hello world")])
        self.assertEqual(self.evaluate()["summary"]["wer"], 0)

    def test_spoken_parentheticals_and_curly_apostrophes_are_preserved(self):
        self.fixture([("Hydrogen (one proton and one electron) is light.", "Hydrogen one proton and one electron is light"),
                      ("It isn‘t alone.", "It isn't alone."), ("That is helpful.", "That (is) helpful.")])
        result = self.evaluate()
        self.assertEqual(result["summary"]["wer"], 0)
        self.assertIn("one proton", result["cases"][0]["normalized_reference"])

    def test_cannot_label_a_sample_as_full_split(self):
        self.fixture([("hello", "hello")])
        self.manifest["selection"]["available_cases"] = 100
        write_json(self.root / "manifest.json", self.manifest)
        self.events[0]["manifest_sha256"] = digest(self.root / "manifest.json")
        with self.assertRaisesRegex(ValueError, "coverage"):
            self.evaluate()

    def test_failure_is_not_dropped_or_replaced_by_reference(self):
        self.fixture([("hello world", "hello world"), ("one cat", "fabricated output")], [None, "decoder error"])
        result = self.evaluate()
        self.assertEqual(result["summary"]["failed_clips"], 1)
        self.assertEqual(result["summary"]["deletions"], 2)
        self.assertEqual(result["cases"][1]["normalized_hypothesis"], "")
        self.assertEqual(result["summary"]["wer"], .5)

    def test_empty_output_and_insertions_over_100_percent(self):
        self.fixture([("hello", ""), ("cat", "cat dog bird mouse")])
        result = self.evaluate()["summary"]
        self.assertEqual(result["empty_outputs"], 1)
        self.assertEqual(result["wer"], 2)

    def test_empty_reference_has_no_invented_zero_denominator(self):
        self.fixture([("", "hello")])
        result = self.evaluate()["summary"]
        self.assertIsNone(result["wer"])
        self.assertEqual(result["insertions"], 1)

    def test_first_clip_excluded_from_percentiles(self):
        self.fixture([("hello", "hello")] * 3)
        self.events[2]["inference_seconds"] = 100
        result = self.evaluate()["summary"]
        self.assertAlmostEqual(result["inference_p50_seconds"], .25)
        self.assertEqual(result["first_clip_inference_seconds"], 100)
        self.assertEqual(result["timed_clips_excluding_first"], 2)

    def test_rejects_incomplete_duplicate_foreign_or_mismatched_runs(self):
        mutations = [lambda e: e.pop(), lambda e: e.pop(2), lambda e: e.insert(2, copy.deepcopy(e[2])),
                     lambda e: e[2].update(id="foreign"), lambda e: e[2].update(audio_sha256="changed"),
                     lambda e: e[0].update(manifest_sha256="changed"), lambda e: e[0].update(cleanup=True),
                     lambda e: e[-1].update(errors=100), lambda e: e[2].update(inference_seconds=float("nan")),
                     lambda e: e[2].update(audio_seconds=3), lambda e: e[0].update(profile="debug")]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.fixture([("hello", "hello"), ("world", "world")])
                mutation(self.events)
                with self.assertRaises(ValueError):
                    self.evaluate()

    def test_markdown_rejects_different_corpora_or_normalizers(self):
        self.fixture([("hello", "hello")])
        first = self.evaluate()
        second = copy.deepcopy(first)
        second["engine"] = "parakeet"
        self.assertIn("Parakeet", markdown([first, second]))
        second["manifest_sha256"] = "other"
        with self.assertRaises(ValueError):
            markdown([first, second])
        second["manifest_sha256"] = first["manifest_sha256"]
        second["normalization"]["version"] = "different"
        with self.assertRaises(ValueError):
            markdown([first, second])

    def test_sampling_stable_across_input_order(self):
        rows = [{"id": str(i)} for i in range(30)]
        self.assertEqual(select_cases(rows, 10, 5), select_cases(list(reversed(rows)), 10, 5))
        self.assertNotEqual(select_cases(rows, 10, 5), select_cases(rows, 10, 6))
        with self.assertRaises(ValueError):
            select_cases(rows + rows, 10, 5)
        with self.assertRaises(ValueError):
            select_cases(rows, 31, 5)

    def test_fleurs_uses_recording_ids_and_raw_references(self):
        tsv = "1\ta.wav\tHello!\thello\th e l l o\t16000\tMALE\n1\tb.wav\tHello!\thello\th e l l o\t16000\tFEMALE\n"
        rows = fleurs_rows(tsv)
        self.assertEqual([row["id"] for row in rows], ["a", "b"])
        self.assertEqual(rows[0]["reference"], "Hello!")

    def test_common_voice_adapter_and_path_traversal(self):
        (self.root / "clips").mkdir()
        (self.root / "test.tsv").write_text("client_id\tpath\tsentence\nprivate-id\tclip.mp3\tHello there\n")
        rows = common_voice_rows(self.root)
        self.assertEqual(rows, [{"id": "clip", "reference": "Hello there", "source_audio": "clip.mp3"}])
        (self.root / "test.tsv").write_text("path\tsentence\n../escape.mp3\tHello\n")
        with self.assertRaises(ValueError):
            common_voice_rows(self.root)

    def test_audio_conversion_resamples_and_downmixes(self):
        import numpy as np
        import soundfile as sf
        audio = np.column_stack([np.full(4800, .2), np.full(4800, .4)])
        source = io.BytesIO()
        sf.write(source, audio, 48000, subtype="FLOAT", format="WAV")
        source.seek(0)
        target = self.root / "converted.wav"
        duration = convert_audio(source, target)
        result, rate = sf.read(target)
        self.assertEqual(rate, 16000)
        self.assertEqual(len(result), 1600)
        self.assertEqual(duration, .1)
        self.assertAlmostEqual(float(result[100:-100].mean()), .3, places=4)
        self.assertEqual(sf.info(target).subtype, "PCM_16")

    def test_download_checks_integrity_and_reuses_cache(self):
        target = self.root / "download.bin"
        expected = hashlib.sha256(b"complete content").hexdigest()
        with patch("urllib.request.urlopen", return_value=io.BytesIO(b"truncated")):
            with self.assertRaisesRegex(ValueError, "checksum"):
                download("https://example.invalid/data", target, expected)
        self.assertFalse(target.exists())
        self.assertFalse(target.with_suffix(".bin.part").exists())
        with patch("urllib.request.urlopen", return_value=io.BytesIO(b"complete content")):
            download("https://example.invalid/data", target, expected)
        with patch("urllib.request.urlopen") as network:
            download("https://example.invalid/data", target, expected)
            network.assert_not_called()
        target.write_bytes(b"tampered cache")
        with self.assertRaisesRegex(ValueError, "checksum"):
            download("https://example.invalid/data", target, expected)

    def test_common_voice_mp3_decodes_without_ffmpeg(self):
        import numpy as np
        import soundfile as sf
        source = io.BytesIO()
        audio = .2 * np.sin(2 * np.pi * 440 * np.arange(4800) / 48000)
        sf.write(source, audio, 48000, format="MP3", subtype="MPEG_LAYER_III")
        source.seek(0)
        target = self.root / "mp3-converted.wav"
        duration = convert_audio(source, target)
        self.assertGreater(duration, .09)
        self.assertLess(duration, .12)
        result, rate = sf.read(target)
        self.assertEqual(rate, 16000)
        self.assertGreater(float(np.max(np.abs(result))), .1)

    def test_common_voice_prepare_end_to_end_without_network(self):
        import numpy as np
        import soundfile as sf
        source = self.root / "release"
        (source / "clips").mkdir(parents=True)
        for index in range(3):
            sf.write(source / "clips" / f"{index}.wav", np.full(1600, .1), 16000)
        (source / "test.tsv").write_text("path\tsentence\n0.wav\tzero\n1.wav\tone\n2.wav\ttwo\n")
        output = self.root / "prepared"
        with patch("urllib.request.urlopen") as network, contextlib.redirect_stdout(io.StringIO()):
            manifest = prepare("common-voice-en-test", output, self.root / "cache", limit=2,
                               source_dir=source, version="fixture", source_url="https://example.invalid/release")
            network.assert_not_called()
        self.assertEqual(manifest["selection"]["scope"], "deterministic-sample")
        self.assertEqual(manifest["selection"]["available_cases"], 3)
        self.assertEqual(len(manifest["cases"]), 2)
        for case in manifest["cases"]:
            self.assertEqual(case["audio_sha256"], digest(output / case["wav"]))
        with self.assertRaisesRegex(ValueError, "overwrite"):
            prepare("common-voice-en-test", output, self.root / "cache")

    def test_percentile_empty_and_single(self):
        self.assertIsNone(percentile([], .95))
        self.assertEqual(percentile([2], .95), 2)

    def test_publication_recomputes_scores_and_replaces_only_readme_block(self):
        self.fixture([("hello", "world")])
        self.evaluate()
        # The publisher must ignore this tampered summary and use raw outputs.
        write_json(self.root / "scored.json", {"summary": {"wer": 0}})
        write_json(self.root / "run.json", {"exit_code": 0, "binary_unchanged_during_run": True,
                   "manifest_sha256": digest(self.root / "manifest.json"), "engine": "whisper",
                   "hardware": {"cpu": "fixture"}, "os": "fixture", "binary_sha256": "fixture",
                   "model_files_sha256": {"model": "fixture"}})
        readme = self.root / "README.md"
        readme.write_text("Before\n<!-- public-benchmarks:start -->\nold\n<!-- public-benchmarks:end -->\nAfter\n")
        output = self.root / "published"
        publish(argparse.Namespace(runs=[self.root], output=output, readme=readme))
        published = json.loads((output / "fixture-whisper/scored.json").read_text())
        self.assertEqual(published["summary"]["wer"], 1)
        self.assertIn("100.00%", readme.read_text())
        self.assertTrue(readme.read_text().startswith("Before\n"))
        self.assertTrue(readme.read_text().endswith("After\n"))
        self.assertFalse((output / "fixture-whisper/audio").exists())


if __name__ == "__main__":
    unittest.main()
