#!/usr/bin/env python3
"""Compare the owner's Silero v6 ONNX model on the same PCM fixtures.

Usage: python vad-reference.py manifest.json model.onnx report.json
Requires numpy and onnxruntime in an isolated benchmark environment.
Uses the owner's 512-sample / 64-sample context / recurrent-state contract:
https://github.com/snakers4/silero-vad/blob/v6.0/src/silero_vad/utils_vad.py
"""
import hashlib
import json
from pathlib import Path
import sys
import time
import wave

import numpy as np
import onnxruntime as ort

manifest_path, model_path, report_path = map(Path, sys.argv[1:])
options = ort.SessionOptions()
options.inter_op_num_threads = 1
options.intra_op_num_threads = 1
session = ort.InferenceSession(str(model_path), options, providers=["CPUExecutionProvider"])


def probabilities(samples):
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros((1, 64), dtype=np.float32)
    values = []
    for offset in range(0, len(samples), 512):
        chunk = np.zeros((1, 512), dtype=np.float32)
        tail = samples[offset:offset + 512]
        chunk[0, :len(tail)] = tail
        audio = np.concatenate((context, chunk), axis=1)
        probability, state = session.run(None, {
            "input": audio, "state": state, "sr": np.array(16000, dtype=np.int64),
        })
        values.append(float(probability.flat[0]))
        context = audio[:, -64:]
    return values


rows = []
for case in json.loads(manifest_path.read_text())["cases"]:
    path = manifest_path.parent / case["wav"]
    with wave.open(str(path)) as wav:
        assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16000, 1, 2)
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768
    start = time.perf_counter()
    raw = probabilities(samples)
    elapsed = (time.perf_counter() - start) * 1000
    peak = float(np.max(np.abs(samples))) if len(samples) else 0
    gain = min(1000, max(1, 0.1 / peak)) if peak > 1e-10 else 1
    start = time.perf_counter()
    rescue = probabilities(samples * gain) if gain > 1 else raw
    rescue_ms = (time.perf_counter() - start) * 1000 if gain > 1 else 0
    rows.append({
        "name": case["name"], "category": case["category"], "expectedSpeech": case["speech"],
        "expectedText": case["text"], "seconds": len(samples) / 16000,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "probabilities": raw, "maxProbability": max(raw, default=0),
        "detectorGain": gain, "rescueProbabilities": rescue,
        "milliseconds": elapsed, "rescueMilliseconds": rescue_ms,
    })
report_path.write_text(json.dumps({
    "runtime": ort.__version__, "model": model_path.name,
    "modelSha256": hashlib.sha256(model_path.read_bytes()).hexdigest(),
    "frameSamples": 512, "results": rows,
}, indent=2))
for threshold in (.85, .5, .3, .2):
    for rescue in (False, True):
        dropped = passed = 0
        for row in rows:
            maximum = max(row["probabilities"] + (row["rescueProbabilities"] if rescue else []), default=0)
            dropped += row["expectedSpeech"] and maximum < threshold
            passed += not row["expectedSpeech"] and maximum >= threshold
        print({"threshold": threshold, "gainRescue": rescue, "droppedSpeech": dropped, "passedNoise": passed})
