#!/usr/bin/env python3
"""Check the locked macOS graph against OSV; exceptions are version-specific and expire."""
import datetime
import json
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def check():
    by_id = {}
    for target in ("aarch64-apple-darwin", "x86_64-apple-darwin"):
        metadata = json.loads(subprocess.check_output([
            "cargo", "metadata", "--locked", "--format-version", "1", "--features", "local-stt,parakeet",
            "--filter-platform", target, "--manifest-path", str(ROOT / "src-tauri/Cargo.toml")]))
        resolved = {node["id"] for node in metadata["resolve"]["nodes"]}
        by_id.update((p["id"], p) for p in metadata["packages"]
                     if p["id"] in resolved and (p["source"] or "").startswith("registry+"))
    packages = list(by_id.values())
    exceptions = json.loads((ROOT / "security/rust-advisories.json").read_text())
    today = datetime.date.today().isoformat()
    if any(e["expires"] < today for e in exceptions):
        raise SystemExit("Rust advisory exceptions have expired; review security/rust-advisories.json")
    allowed = {(e["name"], e["version"], advisory) for e in exceptions for advisory in e["ids"]}
    findings = []
    for offset in range(0, len(packages), 100):
        batch = packages[offset:offset + 100]
        payload = {"queries": [{"package": {"name": p["name"], "ecosystem": "crates.io"}, "version": p["version"]} for p in batch]}
        request = urllib.request.Request("https://api.osv.dev/v1/querybatch", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=45) as response:
                    results = json.load(response)["results"]
                break
            except (OSError, ValueError):
                if attempt == 2:
                    raise
                time.sleep(2)
        if len(results) != len(batch):
            raise SystemExit("Incomplete OSV response")
        for package, result in zip(batch, results):
            for advisory in result.get("vulns", []):
                key = (package["name"], package["version"], advisory["id"])
                if key not in allowed:
                    findings.append(key)
    if findings:
        raise SystemExit("Unreviewed Rust advisories:\n" + "\n".join(" ".join(row) for row in findings))
    print(f"Checked {len(packages)} macOS packages; no unreviewed advisories")


if __name__ == "__main__":
    check()
