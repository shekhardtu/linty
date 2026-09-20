#!/usr/bin/env python3
"""Collect shipped dependency notices; --check verifies the checked-in inventory.

Generation needs Cargo's macOS dependency sources, node_modules, the SwiftPM
checkout, and gh for license files omitted from crates. License URLs use commits.
The output conservatively includes native build dependencies as well.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "src-tauri/licenses"
INVENTORY = DIRECTORY / "inventory.json"
NOTICES = DIRECTORY / "THIRD_PARTY_NOTICES.txt"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inputs():
    result = {}
    for name in ["yarn.lock", "src-tauri/Cargo.lock", "src-tauri/swift/Package.resolved"]:
        data = (ROOT / name).read_text()
        # Release preparation changes only the app's version, not its dependencies.
        if name.endswith("Cargo.lock"):
            data = re.sub(r'(\[\[package\]\]\nname = "linty"\nversion = ")[^"]+', r'\g<1>APP_VERSION', data)
        result[name] = digest(data.encode())
    return result


def notice_files(root):
    return sorted(p for p in root.rglob("*") if p.is_file()
                  and re.search(r"(?i)(^|[._-])(licen[cs]e|copying|notice|copyright)([._-]|$)", p.name)
                  and p.suffix.lower() not in (".rs", ".c", ".h", ".py", ".json"))


def github(path):
    return json.loads(subprocess.check_output(["gh", "api", path], stderr=subprocess.PIPE))


def omitted_notices(package):
    root = Path(package["manifest_path"]).parent
    vcs = root / ".cargo_vcs_info.json"
    revision = json.loads(vcs.read_text()).get("git", {}).get("sha1") if vcs.exists() else None
    repository = package.get("repository") or ""
    match = re.search(r"github.com/([^/]+/[^/#]+)", repository)
    if not match:
        raise ValueError(f"No license files/source for {package['name']}")
    repo = match[1].removesuffix(".git")
    if not revision:
        for ref in ["v" + package["version"], package["version"], "HEAD"]:
            try:
                revision = github(f"repos/{repo}/commits/{ref}")["sha"]
                break
            except subprocess.CalledProcessError:
                continue
    entries = github(f"repos/{repo}/contents?ref={revision}")
    result = []
    for entry in entries:
        if entry["type"] == "file" and re.match(r"(?i)^(licen[cs]e|copying|notice|copyright)([._-]|$)", entry["name"]):
            url = f"https://raw.githubusercontent.com/{repo}/{revision}/{entry['path']}"
            with urllib.request.urlopen(url, timeout=30) as response:
                result.append((url, response.read().decode("utf-8")))
    if not result and re.search(r"\bMIT\b", package.get("license") or ""):
        # Some older MIT crates never included a copyright/license file.
        # Preserve the published authors and declaration without inventing dates.
        template = (DIRECTORY / "MIT-terms.txt").read_text()
        authors = ", ".join(package.get("authors", []))
        headers = set()
        for source in root.rglob("*.rs"):
            prefix = re.match(r"(?:(?://[^\n]*\n)|\s)*", source.read_text(errors="replace")).group()
            if "copyright" in prefix.lower():
                headers.add(prefix.strip())
        attribution = "\n\n".join(sorted(headers))
        template = attribution + "\n\n" + template if attribution else template
        result = [(f"{package['source']} (Cargo metadata; upstream omits license file)",
                   f"{package['name']} {package['version']}\nSelected license: MIT (from the package declaration)\nPublished authors: {authors}\n\n{template}")]
    if not result and package.get("license") == "MPL-2.0":
        # selectors 0.36 publishes MPL source headers but no license file,
        # including in its pinned upstream tree. Preserve its declaration
        # with the unmodified terms from mozilla.org/media/MPL/2.0/index.txt.
        template = (DIRECTORY / "MPL-2.0-terms.txt").read_text()
        authors = ", ".join(package.get("authors", []))
        result = [(f"{package['source']} (Cargo metadata; upstream omits license file)",
                   f"{package['name']} {package['version']}\nDeclared license: MPL-2.0\nPublished authors: {authors}\n"
                   f"License terms: https://www.mozilla.org/media/MPL/2.0/index.txt\n\n{template}")]
    if not result:
        raise ValueError(f"Missing upstream notices: {repo}@{revision}")
    return result


def collect():
    metadata = json.loads(subprocess.check_output([
        "cargo", "metadata", "--locked", "--format-version", "1", "--features", "local-stt,parakeet",
        "--filter-platform", "aarch64-apple-darwin", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml")]))
    resolved = {node["id"] for node in metadata["resolve"]["nodes"]}
    packages = [p for p in metadata["packages"] if p["id"] in resolved and p["name"] != "linty"]

    def native(package):
        root = Path(package["manifest_path"]).parent
        files = notice_files(root)
        notices = [(f"https://docs.rs/crate/{package['name']}/{package['version']}/source/{p.relative_to(root)}", p.read_text(errors="replace")) for p in files]
        if not notices:
            notices = omitted_notices(package)
        return {"ecosystem": "Cargo", "name": package["name"], "version": package["version"],
                "license": package["license"], "repository": package["repository"]}, notices

    with ThreadPoolExecutor(max_workers=6) as pool:
        components = list(pool.map(native, packages))

    seen = set()

    def javascript(name, parent):
        roots = [parent, *parent.parents]
        root = next((p / "node_modules" / name for p in roots if (p / "node_modules" / name / "package.json").is_file()), None)
        if root is None:
            raise ValueError(f"Install JavaScript dependency {name}")
        data = json.loads((root / "package.json").read_text())
        identity = (name, data["version"])
        if identity in seen:
            return
        seen.add(identity)
        files = [p for p in notice_files(root) if "node_modules" not in p.relative_to(root).parts]
        if not files:
            raise ValueError(f"No notices for npm {name}")
        components.append(({"ecosystem": "npm", "name": name, "version": data["version"],
                            "license": data.get("license"), "repository": data.get("repository")},
                           [(f"npm:{name}@{data['version']}/{p.relative_to(root)}", p.read_text(errors="replace")) for p in files]))
        for dependency in data.get("dependencies", {}):
            javascript(dependency, root)

    for name in json.loads((ROOT / "package.json").read_text())["dependencies"]:
        javascript(name, ROOT)
    pins = json.loads((ROOT / "src-tauri/swift/Package.resolved").read_text())["pins"]
    for pin in pins:
        checkouts = ROOT / "src-tauri/swift/.build/checkouts"
        root = next((p for p in checkouts.iterdir() if p.name.lower() == pin["identity"]), None)
        if root is None:
            raise ValueError("Run swift package resolve before collecting notices")
        actual = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        if actual != pin["state"]["revision"]:
            raise ValueError("Swift checkout differs from Package.resolved")
        files = notice_files(root)
        components.append(({"ecosystem": "Swift", "name": pin["identity"], "version": pin["state"]["version"],
                            "repository": pin["location"], "revision": actual},
                           [(f"{pin['location']}@{actual}/{p.relative_to(root)}", p.read_text(errors="replace")) for p in files]))
    components.append(({"ecosystem": "Model", "name": "S1-mini by Superwhisper", "version": "optional download"},
                       [(str(p.relative_to(ROOT)), p.read_text()) for p in notice_files(DIRECTORY / "s1-mini")]))
    texts = {}
    records = []
    for component, notices in sorted(components, key=lambda row: (row[0]["ecosystem"], row[0]["name"], row[0]["version"])):
        component["notices"] = []
        for source, text in notices:
            text = "\n".join(line.rstrip() for line in text.splitlines()).strip() + "\n"
            key = digest(text.encode())
            texts[key] = text
            component["notices"].append({"source": source, "sha256": key})
        records.append(component)
    lines = ["Linty third-party notices", "", "Includes native macOS dependencies (including build tools), frontend runtime dependencies,",
             "the Swift speech bridge, and the optional S1 model notices. Components retain their own licenses.", ""]
    for component in records:
        lines.extend([f"{component['ecosystem']}: {component['name']} {component['version']}",
                      f"Declared license: {component.get('license') or 'See notices below'}"])
        for notice in component["notices"]:
            lines.extend([f"  Source: {notice['source']}", f"  License text: {notice['sha256']}"])
        lines.append("")
    for key, text in sorted(texts.items()):
        lines.extend([f"=== License text SHA-256: {key} ===", text])
    output = "\n".join(lines).rstrip() + "\n"
    NOTICES.write_text(output)
    INVENTORY.write_text(json.dumps({"inputs": inputs(), "notices_sha256": digest(output.encode()), "components": records}, indent=2) + "\n")
    print(f"Collected {len(records)} components and {len(texts)} distinct notice texts")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        inventory = json.loads(INVENTORY.read_text())
        if inventory["inputs"] != inputs() or inventory["notices_sha256"] != digest(NOTICES.read_bytes()):
            raise SystemExit("Third-party notices are stale; run python3 scripts/third-party-notices.py")
        print("Third-party notices match the dependency lockfiles")
    else:
        collect()
