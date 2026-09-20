#!/usr/bin/env node
// Require copies of Linty below a version to install the latest release.
// Everything happens on GitHub: this edits `minimum_version` in latest.json
// of the latest release, which every copy reads on its next update check.
//
//   node scripts/force-update.mjs --show
//   node scripts/force-update.mjs 0.0.40          copies below 0.0.40 must update
//   node scripts/force-update.mjs --latest        copies below the latest release must update
//   node scripts/force-update.mjs --clear --allow-lower
//   add --dry-run to print the result without uploading
//
// Needs the GitHub CLI (`gh`) signed in with write access to the repository.
// See docs/runbooks/force-update.md.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { minimumVersion, normalizeVersion, withMinimumVersion } from "../src/lib/force-update.util.ts";

const REPO = "shekhardtu/linty";
const LATEST_MANIFEST = `https://github.com/${REPO}/releases/latest/download/latest.json`;
const PROPAGATION_MS = 120_000;

export function parseArgs(argv) {
  const options = { show: false, latest: false, clear: false, allowLower: false, dryRun: false, version: null };
  for (const arg of argv) {
    if (arg === "--show") options.show = true;
    else if (arg === "--latest") options.latest = true;
    else if (arg === "--clear") options.clear = true;
    else if (arg === "--allow-lower") options.allowLower = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (!arg.startsWith("--") && options.version === null) options.version = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  const targets = [options.version !== null, options.latest, options.clear].filter(Boolean).length;
  if (!options.show && targets !== 1) throw new Error("give exactly one of <version>, --latest or --clear (or --show)");
  if (options.show && targets > 0) throw new Error("--show takes no other target");
  return options;
}

/** The minimum this run should set, or null to clear it. */
export function requestedMinimum(options, manifest) {
  if (options.clear) return null;
  if (options.latest) return normalizeVersion(String(manifest.version));
  return options.version;
}

function gh(args) {
  // gh reads its own login; release secrets exported in the shell stay out.
  const allowed = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.includes(key)));
  const result = spawnSync("gh", args, { env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`gh ${args[0]} ${args[1]} failed: ${(result.stderr || "").trim()}`);
  return result.stdout;
}

/// A release build reads the current minimum just before publishing; a change
/// made meanwhile would not reach the new release.
function releaseBuildRunning() {
  const runs = JSON.parse(
    gh(["run", "list", "--repo", REPO, "--workflow", "build-dmg.yml", "--limit", "10", "--json", "status"]),
  );
  return runs.some((run) => run.status !== "completed");
}

async function liveMinimum() {
  const response = await fetch(LATEST_MANIFEST, { redirect: "follow", headers: { "Cache-Control": "no-cache" } });
  if (!response.ok) throw new Error(`${LATEST_MANIFEST} answered HTTP ${response.status}`);
  return minimumVersion(await response.json());
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const release = JSON.parse(gh(["release", "view", "--repo", REPO, "--json", "tagName"]));
  const dir = mkdtempSync(join(tmpdir(), "linty-force-update-"));
  try {
    gh(["release", "download", release.tagName, "--repo", REPO, "--pattern", "latest.json", "--dir", dir]);
    const path = join(dir, "latest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const current = minimumVersion(manifest);

    if (options.show) {
      console.log(`Latest release: ${release.tagName}`);
      console.log(current ? `Copies below ${current} must update.` : "No update is required.");
      return;
    }

    const next = withMinimumVersion(manifest, requestedMinimum(options, manifest), { allowLower: options.allowLower });
    console.log(JSON.stringify(next, null, 2));
    if (options.dryRun) {
      console.log("Dry run: nothing uploaded.");
      return;
    }

    if (releaseBuildRunning()) {
      throw new Error("a release build is running; wait for it to publish, then run this again");
    }
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    gh(["release", "upload", release.tagName, path, "--repo", REPO, "--clobber"]);
    const wanted = minimumVersion(next);
    const deadline = Date.now() + PROPAGATION_MS;
    while (Date.now() < deadline) {
      if ((await liveMinimum()) === wanted) {
        console.log(wanted ? `Done. Copies below ${wanted} will update on their next check.` : "Done. No update is required.");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    console.log(`Uploaded, but ${LATEST_MANIFEST} did not show it within ${PROPAGATION_MS / 1000} s. Check again with --show.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`force-update: ${error.message}`);
    process.exit(1);
  });
}
