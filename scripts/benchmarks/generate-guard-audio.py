#!/usr/bin/env python3
"""Make a reproducible, local-only regression corpus; never records the mic.

Usage: python3 scripts/benchmarks/generate-guard-audio.py [output-directory]
Requires macOS say/afconvert. Generated audio is intentionally not committed.
"""
import array
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import subprocess
import sys
import wave

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", nargs="?", type=Path, default=Path("artifacts/transcription-guards"))
parser.add_argument("--natural-wav", type=Path, help="Optional human speech, 16 kHz mono PCM16")
parser.add_argument("--natural-text", type=Path, help="Reference transcript for --natural-wav")
args = parser.parse_args()
if bool(args.natural_wav) != bool(args.natural_text):
    parser.error("--natural-wav and --natural-text must be supplied together")
root = args.output
root.mkdir(parents=True, exist_ok=True)
cases = []


def save(name, samples, text, category, language="en"):
    path = root / f"{name}.wav"
    pcm = array.array("h", (max(-32768, min(32767, round(s))) for s in samples))
    if sys.byteorder != "little":
        pcm.byteswap()
    with wave.open(str(path), "wb") as out:
        out.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        out.writeframes(pcm.tobytes())
    cases.append({"name": name, "wav": path.name, "text": text,
                  "speech": bool(text), "category": category, "language": language,
                  "synthetic": not category.startswith("human"),
                  "seconds": len(samples) / 16000,
                  "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})


def spoken(name, text, voice="Samantha", language="en"):
    aiff = root / f"{name}.aiff"
    wav = root / f"{name}-source.wav"
    subprocess.run(["say", "-v", voice, "-r", "150", "-o", str(aiff), text], check=True)
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1",
                    str(aiff), str(wav)], check=True)
    with wave.open(str(wav), "rb") as source:
        samples = array.array("h", source.readframes(source.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    aiff.unlink()
    wav.unlink()
    save(name, samples, text, "spoken", language)
    return list(samples)


for name, text in [("i", "i"), ("hi", "Hi"), ("no", "No"), ("yeah", "Yeah"), ("okay", "Okay"),
                   ("thanks", "Thanks"), ("thank-you", "Thank you"),
                   ("bye", "Bye"), ("repetition", "No, no, no!"),
                   ("outro", "Thanks for watching")]:
    samples = spoken(name, text)
    if name in {"no", "yeah", "thank-you"}:
        # -30 dB relative to the original; below the old 0.01 RMS gate.
        save(f"{name}-quiet", [s * 10 ** (-30 / 20) for s in samples], text, "quiet")
        save(f"{name}-very-quiet", [s * 10 ** (-50 / 20) for s in samples], text, "very-quiet")
    if name == "thank-you":
        save("thank-you-pauses", [0] * (16000 * 15) + samples + [0] * (16000 * 15),
             text, "pauses")

spoken("german", "Danke", "Anna", "de")
spoken("spanish", "sí.", "Monica", "es")
first = spoken("sentence", "Please send the draft tomorrow. Thank you.")
save("sentence-quiet", [s * 10 ** (-30 / 20) for s in first],
     "Please send the draft tomorrow. Thank you.", "quiet")
save("silence-short", [0] * 16000, "", "silence")
save("silence-long", [0] * (16000 * 30), "", "silence")
rng = random.Random(20260916)
save("noise", [rng.gauss(0, 327.68) for _ in range(16000 * 3)], "", "noise")
save("tone", [327.68 * math.sin(2 * math.pi * 220 * i / 16000)
              for i in range(16000 * 3)], "", "tone")
# Empty presses must also cover nonzero microphone-like input. Pure silence,
# white noise, and a single tone did not expose Parakeet's hum -> "Yeah." case.
for seconds in (0.5, 1, 2):
    noise_rng = random.Random(17 + round(seconds * 16000))
    count = round(seconds * 16000)
    hiss = [noise_rng.gauss(0, 0.001) for _ in range(count)]
    hum = [0.003 * math.sin(2 * math.pi * 60 * i / 16000)
           + 0.001 * math.sin(2 * math.pi * 120 * i / 16000)
           + hiss[i] * 0.2 for i in range(count)]
    clicks = list(hiss)
    for start in (0, count - 200):
        for j in range(200):
            clicks[start + j] += noise_rng.gauss(0, 0.02) * math.exp(-j / 30)
    for kind, samples in (("silence", [0] * count), ("hiss", hiss),
                          ("hum", hum), ("clicks", clicks)):
        save(f"empty-{kind}-{seconds:g}s", [s * 32768 for s in samples],
             "", f"synthetic-{kind}", "auto")
if args.natural_wav:
    with wave.open(str(args.natural_wav), "rb") as source:
        assert (source.getframerate(), source.getnchannels(), source.getsampwidth()) == (16000, 1, 2)
        samples = array.array("h", source.readframes(source.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    text = args.natural_text.read_text().strip()
    save("natural", samples, text, "human")
    save("natural-quiet", [s * 10 ** (-30 / 20) for s in samples], text, "human-quiet")
    save("natural-very-quiet", [s * 10 ** (-50 / 20) for s in samples], text, "human-very-quiet")
    save("natural-pauses", [0] * (16000 * 15) + list(samples) + [0] * (16000 * 15),
         text, "human-pauses")
(root / "manifest.json").write_text(json.dumps({"cases": cases}, indent=2))
print(f"Prepared {len(cases)} cases in {root}")
