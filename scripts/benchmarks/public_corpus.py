#!/usr/bin/env python3
"""Prepare public English corpora, run production STT, and publish reproducible reports.

See docs/PUBLIC-BENCHMARKS.md. Subcommands have --help. No app data is used.
"""
import argparse
import datetime
import importlib.metadata
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys

from public_corpus_data import digest, prepare, write_json
from public_corpus_score import markdown, score

ROOT = Path(__file__).resolve().parents[2]
DATASETS = ("librispeech-test-clean", "librispeech-test-other", "fleurs-en_us-test", "common-voice-en-test")
MODELS = Path.home() / "Library/Application Support/ai.linty.desktop/models"
BINARY = ROOT / "src-tauri/target/release/examples/corpus_eval"


def command(*args):
    result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True, check=False)
    return {"exit_code": result.returncode, "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}


def source_hashes():
    files = set()
    for directory in (ROOT / "src-tauri/src", ROOT / "src-tauri/swift/Sources"):
        for pattern in ("*.rs", "*.swift", "*.py", "*.txt"):
            files.update(directory.rglob(pattern))
    for name in ("src-tauri/examples/corpus_eval.rs", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
                 "src-tauri/build.rs", "src-tauri/swift/Package.swift", "src-tauri/swift/Package.resolved",
                 "scripts/benchmarks/public_corpus.py", "scripts/benchmarks/public_corpus_data.py",
                 "scripts/benchmarks/public_corpus_score.py", "scripts/benchmarks/public-requirements.txt"):
        files.add(ROOT / name)
    return {str(path.relative_to(ROOT)): digest(path) for path in sorted(files) if path.is_file()}


def model_hashes(models, engine):
    name = "ggml-large-v3-turbo-q5_0.bin" if engine == "whisper" else "parakeet-tdt-0.6b-v3"
    path = models / name
    if not path.exists():
        raise ValueError(f"Install {name} in Linty first; benchmark does not download models")
    files = [path] if path.is_file() else sorted(path.rglob("*"))
    return {str(file.relative_to(models)): digest(file) for file in files if file.is_file() and file.name != ".DS_Store"}


def run(args):
    manifest = args.manifest.resolve()
    output = args.output.resolve()
    if output.exists():
        raise ValueError(f"Refusing to overwrite run directory: {output}")
    if not manifest.is_file():
        raise ValueError(f"Manifest missing: {manifest}")
    if not args.skip_build:
        subprocess.run(["cargo", "build", "--release", "--locked", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"),
                        "--example", "corpus_eval", "--features", "local-stt,parakeet"], cwd=ROOT, check=True)
    binary = args.binary.resolve()
    if not binary.is_file():
        raise ValueError("corpus_eval binary missing")
    output.mkdir(parents=True)
    shutil.copyfile(manifest, output / "manifest.json")
    metadata = {"schema_version": 1, "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "engine": args.engine, "model_files_sha256": model_hashes(args.models, args.engine),
                "binary_sha256": digest(binary), "source_files_sha256": source_hashes(),
                "git_head": command("git", "rev-parse", "HEAD")["stdout"],
                "git_dirty": bool(command("git", "status", "--porcelain")["stdout"]),
                "python": platform.python_version(),
                "python_packages": {dist.metadata["Name"]: dist.version for dist in importlib.metadata.distributions()},
                "os": command("sw_vers"), "hardware": command("sysctl", "machdep.cpu.brand_string", "hw.memsize", "hw.logicalcpu"),
                "power": command("pmset", "-g", "batt"), "thermal_before": command("pmset", "-g", "therm"),
                "build_requested": not args.skip_build, "timeout_seconds": args.timeout,
                "manifest_sha256": digest(manifest),
                "measurement_scope": "direct WAV -> production STT; resident model; no cleanup, dictionary, microphone, UI or paste"}
    write_json(output / "run.json", metadata)
    print(f"Running {args.engine} on {manifest.parent.name}; logs: {output / 'native.log'}", flush=True)
    with (output / "native.log").open("w") as log:
        try:
            process = subprocess.run([str(binary), args.engine, str(args.models.resolve()), str(manifest), str(output / "results.jsonl")],
                                     stdout=log, stderr=log, timeout=args.timeout, check=False)
            metadata["exit_code"] = process.returncode
        except subprocess.TimeoutExpired:
            metadata["exit_code"] = None
            metadata["error"] = "run timeout; partial results retained, not publishable"
    metadata["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    metadata["thermal_after"] = command("pmset", "-g", "therm")
    metadata["source_unchanged_during_run"] = metadata["source_files_sha256"] == source_hashes()
    metadata["binary_unchanged_during_run"] = metadata["binary_sha256"] == digest(binary)
    write_json(output / "run.json", metadata)
    if metadata["exit_code"] != 0:
        raise ValueError(f"Native run failed; inspect {output / 'native.log'}")
    if not metadata["binary_unchanged_during_run"]:
        raise ValueError("Native binary changed during run")
    report = score(output / "manifest.json", output / "results.jsonl", output)
    print(markdown([report]), flush=True)


def publish(args):
    # Recompute every score from preserved raw outputs. Never trust an edited summary.
    reports = []
    names = []
    shared_environment = None
    model_versions = {}
    for directory in args.runs:
        meta = json.loads((directory / "run.json").read_text())
        if meta.get("exit_code") != 0 or not meta.get("binary_unchanged_during_run"):
            raise ValueError(f"Incomplete/unverified run: {directory}")
        report = score(directory / "manifest.json", directory / "results.jsonl", directory)
        if meta.get("manifest_sha256") != report["manifest_sha256"] or meta.get("engine") != report["engine"]:
            raise ValueError("Run provenance does not match results")
        environment = {key: meta[key] for key in ("hardware", "os", "binary_sha256")}
        if shared_environment is not None and environment != shared_environment:
            raise ValueError("Publish different hardware, operating systems, or native binaries separately")
        shared_environment = environment
        previous = model_versions.setdefault(report["engine"], meta["model_files_sha256"])
        if previous != meta["model_files_sha256"]:
            raise ValueError("Publish different model versions separately")
        reports.append(report)
        names.append(f"{report['dataset_id']}-{report['engine']}")
    table = markdown(reports)
    if args.output.exists():
        raise ValueError(f"Refusing to overwrite publication: {args.output}")
    if args.readme:
        original = args.readme.read_text()
        start, end = "<!-- public-benchmarks:start -->", "<!-- public-benchmarks:end -->"
        if original.count(start) != 1 or original.count(end) != 1 or original.index(start) > original.index(end):
            raise ValueError("README needs one ordered pair of public-benchmarks markers")
    args.output.mkdir(parents=True)
    for directory, name in zip(args.runs, names):
        target = args.output / name
        target.mkdir()
        for filename in ("manifest.json", "results.jsonl", "run.json", "scored.json", "clips.csv"):
            shutil.copyfile(directory / filename, target / filename)
    lines = ["# Public corpus measurements", "", table,
             "Each run directory contains the dataset manifest, raw model outputs, environment/model/source hashes, scored JSON, and clip CSV. "
             "Audio is downloaded from the attributed sources in the manifests and is not included here.", "", "## Runs", ""]
    for name in names:
        lines.append(f"- [{name}]({name}/scored.json) · [raw outputs]({name}/results.jsonl) · [environment]({name}/run.json) · [manifest]({name}/manifest.json)")
    (args.output / "README.md").write_text("\n".join(lines) + "\n")
    write_json(args.output / "summary.json", [{key: value for key, value in report.items() if key != "cases"} for report in reports])
    if args.readme:
        before, remainder = original.split(start)
        _, after = remainder.split(end)
        args.readme.write_text(before + start + "\n" + table + end + after)
    print(f"Publication written to {args.output}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    prep = sub.add_parser("prepare", help="Download/verify a test split, or import a local Common Voice release")
    prep.add_argument("dataset", choices=DATASETS)
    prep.add_argument("output", type=Path)
    prep.add_argument("--cache", type=Path, default=ROOT / "artifacts/public-corpus/cache")
    prep.add_argument("--limit", type=int, help="Deterministic sample size; omitted = complete test split")
    prep.add_argument("--seed", type=int, default=20260919)
    prep.add_argument("--source-dir", type=Path, help="Common Voice English directory containing test.tsv and clips/")
    prep.add_argument("--version", help="Common Voice release version")
    prep.add_argument("--source-url", help="Common Voice official release page")
    native = sub.add_parser("run", help="Build, transcribe and score one engine on one corpus")
    native.add_argument("engine", choices=("whisper", "parakeet"))
    native.add_argument("manifest", type=Path)
    native.add_argument("output", type=Path)
    native.add_argument("--models", type=Path, default=MODELS)
    native.add_argument("--binary", type=Path, default=BINARY)
    native.add_argument("--skip-build", action="store_true", help="Use an already-built binary; hash recorded")
    native.add_argument("--timeout", type=float, default=10800, help="Whole-run timeout in seconds")
    scoring = sub.add_parser("score", help="Recompute scores from a complete run")
    scoring.add_argument("run", type=Path)
    publishing = sub.add_parser("publish", help="Validate/export evidence and optionally regenerate the README table")
    publishing.add_argument("output", type=Path)
    publishing.add_argument("runs", nargs="+", type=Path)
    publishing.add_argument("--readme", type=Path)
    args = parser.parse_args()
    if args.action == "prepare":
        prepare(args.dataset, args.output, args.cache, args.limit, args.seed, args.source_dir, args.version, args.source_url)
    elif args.action == "run":
        if not 0 < args.timeout < float("inf"):
            raise ValueError("timeout must be finite and positive")
        run(args)
    elif args.action == "score":
        print(markdown([score(args.run / "manifest.json", args.run / "results.jsonl", args.run)]))
    else:
        publish(args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(f"Error: {error}")
