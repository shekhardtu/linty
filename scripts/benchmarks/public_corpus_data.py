"""Pinned public datasets -> portable 16 kHz PCM manifests. Never reads app history."""
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import tarfile
import urllib.request

FLEURS_REVISION = "70bb2e84b976b7e960aa89f1c648e09c59f894dd"
FLEURS_BASE = f"https://huggingface.co/datasets/google/fleurs/resolve/{FLEURS_REVISION}/data/en_us"
LIBRI_MD5 = {
    "test-clean": "32fa31d27d2e1cad72775fee3f4849a9",
    "test-other": "fb5a50374b501bb3bac4815ee91d3135",
}


def digest(path, algorithm="sha256"):
    value = hashlib.new(algorithm)
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def download(url, path, checksum=None, algorithm="sha256"):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        partial = path.with_suffix(path.suffix + ".part")
        print(f"Downloading {url}", flush=True)
        try:
            with urllib.request.urlopen(url, timeout=60) as response, partial.open("wb") as target:
                total = 0
                milestone = 0
                while chunk := response.read(1024 * 1024):
                    target.write(chunk)
                    total += len(chunk)
                    if total // (64 * 1024 * 1024) > milestone:
                        milestone = total // (64 * 1024 * 1024)
                        print(f"  {total / 1024**2:.0f} MiB", flush=True)
            if checksum and digest(partial, algorithm) != checksum:
                raise ValueError(f"Download checksum mismatch: {path.name}")
            partial.replace(path)
        finally:
            partial.unlink(missing_ok=True)
    if checksum and digest(path, algorithm) != checksum:
        raise ValueError(f"Cached checksum mismatch: {path}; remove it and retry")
    return path


def select_cases(cases, limit, seed):
    """Hash ranking is deterministic across platforms; sample without looking at audio/results."""
    ids = [case["id"] for case in cases]
    if not cases or len(ids) != len(set(ids)) or any(not key for key in ids):
        raise ValueError("Dataset contains no cases or duplicate/empty IDs")
    if limit is not None and (limit < 1 or limit > len(cases)):
        raise ValueError(f"limit must be between 1 and {len(cases)}")
    ranked = sorted(cases, key=lambda row: (hashlib.sha256(f"{seed}:{row['id']}".encode()).hexdigest(), row["id"]))
    return ranked[:limit] if limit is not None else ranked


def libri_rows(archive, split):
    rows = []
    for member in archive.getmembers():
        if not member.isfile() or not member.name.endswith(".trans.txt"):
            continue
        for line in archive.extractfile(member).read().decode("utf-8").splitlines():
            key, text = line.split(" ", 1)
            rows.append({"id": key, "reference": text, "source_audio": str(Path(member.name).parent / f"{key}.flac"),
                         "speaker": key.split("-")[0]})
    return rows


def fleurs_rows(tsv):
    rows = []
    # FLEURS IDs identify sentences and repeat across recordings. Use WAV IDs.
    for row in csv.reader(io.StringIO(tsv), delimiter="\t", quoting=csv.QUOTE_NONE):
        if len(row) != 7:
            raise ValueError("Expected seven columns in FLEURS TSV")
        rows.append({"id": Path(row[1]).stem, "reference": row[2], "source_audio": row[1], "sentence_id": row[0]})
    return rows


def common_voice_rows(directory):
    directory = Path(directory).resolve()
    rows = []
    with (directory / "test.tsv").open(newline="") as source:
        for row in csv.DictReader(source, delimiter="\t"):
            relative = Path(row["path"])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Unsafe Common Voice audio path")
            clip = (directory / "clips" / relative).resolve()
            if not clip.is_relative_to(directory / "clips"):
                raise ValueError("Common Voice audio escapes clips directory")
            rows.append({"id": relative.stem, "reference": row["sentence"], "source_audio": relative.as_posix()})
    return rows


def convert_audio(source, destination):
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    audio, rate = sf.read(source, dtype="float64", always_2d=True)
    if not len(audio) or not np.isfinite(audio).all() or rate <= 0:
        raise ValueError("Empty or nonfinite source audio")
    audio = audio.mean(axis=1)
    if rate != 16000:
        divisor = math.gcd(rate, 16000)
        audio = resample_poly(audio, 16000 // divisor, rate // divisor)
    # No volume normalization, silence trimming, or denoising.
    sf.write(destination, audio, 16000, subtype="PCM_16", format="WAV")
    return len(audio) / 16000


def prepare(dataset, output, cache, limit=None, seed=20260919, source_dir=None, version=None, source_url=None):
    output, cache = Path(output), Path(cache)
    if output.exists():
        raise ValueError(f"Refusing to overwrite corpus directory: {output}")
    archive = None
    sources = []
    if dataset.startswith("librispeech-"):
        split = dataset.removeprefix("librispeech-")
        if split not in LIBRI_MD5:
            raise ValueError("Only LibriSpeech test-clean and test-other are supported")
        url = f"https://www.openslr.org/resources/12/{split}.tar.gz"
        path = download(url, cache / f"librispeech-{split}.tar.gz", LIBRI_MD5[split], "md5")
        archive = tarfile.open(path)
        rows = libri_rows(archive, split)
        sources = [{"url": url, "sha256": digest(path), "upstream_md5": LIBRI_MD5[split]}]
        info = {"name": "LibriSpeech", "config": "en", "split": split, "version": "SLR12",
                "license": "CC-BY-4.0", "homepage": "https://www.openslr.org/12"}
    elif dataset == "fleurs-en_us-test":
        url = FLEURS_BASE + "/audio/test.tar.gz"
        path = download(url, cache / f"fleurs-{FLEURS_REVISION}-test.tar.gz",
                        "d9c2e37b41aacd41bc283554a0a82b5476b36887049774ecb2819dcaaa55a356")
        tsv_url = FLEURS_BASE + "/test.tsv"
        tsv = download(tsv_url, cache / f"fleurs-{FLEURS_REVISION}-test.tsv",
                       "74c046239374deeb60fa63f258f907388093a32bcaa3140965f70ef05c79f7ca")
        rows = fleurs_rows(tsv.read_text())
        archive = tarfile.open(path)
        # Match only exact basenames and reject ambiguities, without extracting paths.
        members = {}
        for member in archive.getmembers():
            if member.isfile():
                name = Path(member.name).name
                if name in members:
                    raise ValueError(f"Duplicate FLEURS member: {name}")
                members[name] = member.name
        for row in rows:
            row["source_audio"] = members[row["source_audio"]]
        sources = [{"url": url, "sha256": digest(path)}, {"url": tsv_url, "sha256": digest(tsv)}]
        info = {"name": "FLEURS", "config": "en_us", "split": "test", "version": FLEURS_REVISION,
                "license": "CC-BY-4.0", "homepage": "https://huggingface.co/datasets/google/fleurs"}
    elif dataset == "common-voice-en-test":
        if not source_dir or not version or not source_url:
            raise ValueError("Common Voice requires --source-dir, --version, and --source-url")
        rows = common_voice_rows(source_dir)
        sources = [{"url": source_url, "test_tsv_sha256": digest(Path(source_dir) / "test.tsv")}]
        info = {"name": "Common Voice", "config": "en", "split": "test", "version": version,
                "license": "See source release terms", "homepage": source_url}
    else:
        raise ValueError(f"Unknown dataset: {dataset}")
    try:
        selected = select_cases(rows, limit, seed)
        (output / "audio").mkdir(parents=True)
        cases = []
        # Read gzip members in archive order. Random seeks would decompress the
        # archive again per clip; restore deterministic inference order afterward.
        conversion_order = sorted(selected, key=lambda row: archive.getmember(row["source_audio"]).offset) if archive else selected
        for index, row in enumerate(conversion_order):
            relative = f"audio/{hashlib.sha256(row['id'].encode()).hexdigest()}.wav"
            if archive:
                source_bytes = archive.extractfile(row["source_audio"]).read()
                source = io.BytesIO(source_bytes)
            else:
                source_bytes = (Path(source_dir) / "clips" / row["source_audio"]).read_bytes()
                source = io.BytesIO(source_bytes)
            duration = convert_audio(source, output / relative)
            cases.append({**row, "wav": relative, "audio_seconds": duration,
                          "source_audio_sha256": hashlib.sha256(source_bytes).hexdigest(),
                          "audio_sha256": digest(output / relative)})
            if (index + 1) % 100 == 0:
                print(f"Prepared {index + 1}/{len(selected)} clips", flush=True)
        order = {row["id"]: index for index, row in enumerate(selected)}
        cases.sort(key=lambda row: order[row["id"]])
        import importlib.metadata
        manifest = {"schema_version": 1, "dataset_id": dataset, "dataset": info, "language": "en", "sources": sources,
                    "selection": {"method": "sha256(seed:id) ascending", "seed": seed, "limit": limit,
                                  "available_cases": len(rows), "selected_cases": len(cases),
                                  "scope": "full-test-split" if len(cases) == len(rows) else "deterministic-sample"},
                    "conversion": {"sample_rate": 16000, "channels": 1, "format": "PCM_16 WAV",
                                   "channel_mix": "arithmetic mean", "resampling": "scipy.signal.resample_poly defaults",
                                   "packages": {p: importlib.metadata.version(p) for p in ("numpy", "scipy", "soundfile")}},
                    "cases": cases}
        write_json(output / "manifest.json", manifest)
        print(f"Prepared {len(cases)} clips ({sum(c['audio_seconds'] for c in cases)/3600:.2f} hours): {output}", flush=True)
        return manifest
    finally:
        if archive:
            archive.close()
