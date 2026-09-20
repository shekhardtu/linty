#!/usr/bin/env python3
"""Generate independent VAD challenge cases, including public human speech.

Downloads 12 public FSDD clips (six speakers, digits zero/six), CC BY-SA 4.0.
Audio stays in the ignored artifacts directory. No microphone or personal data.
Requires macOS afconvert. Sources and hashes are recorded in the manifest.
"""
import argparse
import array
import concurrent.futures
import hashlib
import json
import math
from pathlib import Path
import random
import subprocess
import sys
import urllib.request
import wave

REVISION = "26eb9aaf76e81b692f806f9140c2d2777410d7a1"
BASE = f"https://raw.githubusercontent.com/Jakobovski/free-spoken-digit-dataset/{REVISION}/recordings"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", nargs="?", type=Path, default=Path("artifacts/vad-v6/challenge"))
parser.add_argument("--holdout", action="store_true", help="Use all digits from recording index 1, plus different noise")
args = parser.parse_args()
root = args.output
root.mkdir(parents=True, exist_ok=True)
cases = []


def save(name, samples, text, category, **metadata):
    path = root / f"{name}.wav"
    pcm = array.array("h", (max(-32768, min(32767, round(s * 32768))) for s in samples))
    if sys.byteorder != "little":
        pcm.byteswap()
    with wave.open(str(path), "wb") as out:
        out.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        out.writeframes(pcm.tobytes())
    cases.append({"name": name, "wav": path.name, "text": text, "speech": bool(text),
                  "category": category, "language": "en" if text else "auto",
                  "seconds": len(samples) / 16000,
                  "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), **metadata})


def fetch(item):
    speaker, digit = item
    filename = f"{digit}_{speaker}_{1 if args.holdout else 0}.wav"
    path = root / f"source-{filename}"
    if not path.exists():
        with urllib.request.urlopen(f"{BASE}/{filename}", timeout=30) as response:
            path.write_bytes(response.read())
    target = root / f"resampled-{filename}"
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1",
                    str(path), str(target)], check=True)
    with wave.open(str(target), "rb") as source:
        pcm = array.array("h", source.readframes(source.getnframes()))
    if sys.byteorder != "little":
        pcm.byteswap()
    return speaker, digit, [s / 32768 for s in pcm], {
        "source": f"{BASE}/{filename}", "sourceSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "license": "CC-BY-SA-4.0", "speaker": speaker,
    }


items = [(speaker, digit) for speaker in ("jackson", "nicolas", "theo", "yweweler", "george", "lucas")
         for digit in (range(10) if args.holdout else (0, 6))]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    for speaker, digit, samples, metadata in pool.map(fetch, items):
        name = f"fsdd-{speaker}-{digit}"
        text = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][digit]
        for attenuation in (0, 30, 50):
            save(f"{name}-minus{attenuation}db", [s * 10 ** (-attenuation / 20) for s in samples],
                 text, "human" if attenuation == 0 else "human-quiet", **metadata)
        save(f"{name}-leading-silence", [0] * 6400 + samples, text, "human-leading-silence", **metadata)
        save(f"{name}-trailing-silence", samples + [0] * 6400, text, "human-trailing-silence", **metadata)
        rms = math.sqrt(sum(s * s for s in samples) / len(samples))
        rng = random.Random(f"{speaker}-{digit}")
        save(f"{name}-noisy", [s + rng.gauss(0, rms / 10 ** (5 / 20)) for s in samples],
             text, "human-noisy-5db-snr", **metadata)
        if args.holdout:
            # Exercise chunk alignment without repeating the tuning clips.
            save(f"{name}-quiet-offset", [0] * 2400 + [s * 10 ** (-30 / 20) for s in samples],
                 text, "human-quiet-offset", **metadata)

# Distinct frequencies, levels, durations, and random seeds from the first corpus.
for frequency in ((45, 90, 170, 330, 440, 900) if args.holdout else (50, 60, 120, 220)):
    for amplitude in ((0.0003, 0.003, 0.03) if args.holdout else (0.0001, 0.001, 0.01, 0.1)):
        for seconds in ((0.4, 0.8, 1.6) if args.holdout else (0.25, 0.5, 1, 3)):
            name = f"hum-{frequency}hz-{amplitude:g}-{seconds:g}s"
            rng = random.Random(name)
            samples = [amplitude * (math.sin(2 * math.pi * frequency * i / 16000)
                       + 0.33 * math.sin(2 * math.pi * 2 * frequency * i / 16000)
                       + rng.gauss(0, 0.05)) for i in range(round(seconds * 16000))]
            save(name, samples, "", "synthetic-hum-sweep")

(root / "manifest.json").write_text(json.dumps({"cases": cases}, indent=2))
print(f"Prepared {len(cases)} independent challenge cases in {root}")
