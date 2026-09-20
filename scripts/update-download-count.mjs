import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const releasesUrl = 'https://api.github.com/repos/shekhardtu/linty/releases';
const marker = /<!-- dmg-downloads:start -->[\s\S]*?<!-- dmg-downloads:end -->/;

export function countDmgDownloads(releases) {
  let downloads = 0;
  let assets = 0;
  for (const release of releases) {
    if (release.draft) continue;
    if (!Array.isArray(release.assets)) throw new Error('GitHub returned a release without assets.');
    for (const asset of release.assets) {
      if (!/\.dmg$/i.test(asset.name ?? '')) continue;
      if (!Number.isSafeInteger(asset.download_count) || asset.download_count < 0) {
        throw new Error('GitHub returned an invalid DMG download count.');
      }
      downloads += asset.download_count;
      assets += 1;
    }
  }
  if (!Number.isSafeInteger(downloads)) throw new Error('DMG download total is out of range.');
  return { downloads, assets };
}

export async function fetchAllReleases({ fetchImpl = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const releases = new Map();
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(`${releasesUrl}?per_page=100&page=${page}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Linty-DMG-download-count',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`GitHub releases request failed (HTTP ${response.status}); count was not updated.`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid release list.');
    for (const release of batch) {
      if (!Number.isSafeInteger(release.id)) throw new Error('GitHub returned an invalid release ID.');
      releases.set(release.id, release);
    }
    if (batch.length < 100) return [...releases.values()].filter(release => !release.draft);
  }
}

export function renderDownloadCount(snapshot) {
  if (!Number.isSafeInteger(snapshot.downloads) || snapshot.downloads < 0 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshot.checkedAt)) {
    throw new Error('Invalid download-count snapshot.');
  }
  const date = snapshot.checkedAt.slice(0, 10);
  const number = snapshot.downloads.toLocaleString('en-US');
  const valueWidth = Math.max(36, number.length * 8 + 14);
  const width = 104 + valueWidth;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="DMG downloads: ${number}; checked ${date}">
  <title>DMG downloads: ${number}; checked ${date}. All published releases, including prereleases. Not unique users.</title>
  <path fill="#555" d="M0 0h104v20H0z"/>
  <path fill="#28756f" d="M104 0h${valueWidth}v20H104z"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="52" y="14">DMG downloads</text>
    <text x="${104 + valueWidth / 2}" y="14">${number}</text>
  </g>
</svg>
`;
  const version = createHash('sha256').update(svg).digest('hex').slice(0, 12);
  const readme = `<!-- dmg-downloads:start -->
  <a href="https://github.com/shekhardtu/linty/releases"><img alt="${number} DMG downloads across all releases; checked ${date}" src="website/downloads.svg?v=${version}" /></a>
  <!-- dmg-downloads:end -->`;
  const website = `<!-- dmg-downloads:start -->
          <p class="fine-print" data-dmg-download-count><a href="https://github.com/shekhardtu/linty/releases">${number} DMG downloads</a> · Checked <time datetime="${snapshot.checkedAt}">${date}</time></p>
          <!-- dmg-downloads:end -->`;
  return { svg, readme, website };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/update-download-count.mjs [--check]\nRefresh the README badge and landing-page snapshot from all GitHub releases.\n--check verifies generated files without network access. GITHUB_TOKEN is optional.');
    return;
  }
  if (args.some(arg => arg !== '--check')) throw new Error('Unknown option. Use --help.');
  const check = args.includes('--check');
  const [readme, website] = await Promise.all(['README.md', 'website/index.html'].map(path => readFile(new URL(path, root), 'utf8')));
  if (![readme, website].every(content => marker.test(content))) throw new Error('Missing download-count markers; count was not updated.');
  let snapshot;
  if (check) {
    snapshot = JSON.parse(await readFile(new URL('website/downloads.json', root), 'utf8'));
  } else {
    const releases = await fetchAllReleases();
    snapshot = { ...countDmgDownloads(releases), releases: releases.length, checkedAt: new Date().toISOString(), source: releasesUrl };
  }
  const rendered = renderDownloadCount(snapshot);
  const outputs = [
    ['website/downloads.json', `${JSON.stringify(snapshot, null, 2)}\n`],
    ['website/downloads.svg', rendered.svg],
    ['README.md', readme.replace(marker, rendered.readme)],
    ['website/index.html', website.replace(marker, rendered.website)],
  ];
  for (const [path, content] of outputs) {
    if (check) {
      if (await readFile(new URL(path, root), 'utf8') !== content) throw new Error(`${path} does not match the DMG download snapshot. Run node scripts/update-download-count.mjs.`);
    } else await writeFile(new URL(path, root), content);
  }
  console.log(`${snapshot.downloads} DMG downloads across ${snapshot.releases} releases; ${check ? 'generated files match' : 'README and landing page updated'}.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
