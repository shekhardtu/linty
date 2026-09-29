import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { countDmgDownloads, fetchAllReleases, releasesUrl } from '../website/downloads.js';
export { countDmgDownloads, fetchAllReleases } from '../website/downloads.js';

const root = new URL('../', import.meta.url);
const marker = /<!-- dmg-downloads:start -->[\s\S]*?<!-- dmg-downloads:end -->/;

export function renderDownloadCount(snapshot) {
  if (!Number.isSafeInteger(snapshot.downloads) || snapshot.downloads < 0 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshot.checkedAt)) {
    throw new Error('Invalid download-count snapshot.');
  }
  const date = snapshot.checkedAt.slice(0, 10);
  const number = snapshot.downloads.toLocaleString('en-US');
  const valueWidth = Math.max(36, number.length * 8 + 14);
  const labelWidth = 78;
  const width = labelWidth + valueWidth;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="Downloads: ${number}; checked ${date}">
  <title>Downloads: ${number}; checked ${date}. DMG installers across all published releases, including prereleases. Not unique users.</title>
  <path fill="#555" d="M0 0h${labelWidth}v20H0z"/>
  <path fill="#28756f" d="M${labelWidth} 0h${valueWidth}v20H${labelWidth}z"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">Downloads</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${number}</text>
  </g>
</svg>
`;
  const version = createHash('sha256').update(svg).digest('hex').slice(0, 12);
  const readme = `<!-- dmg-downloads:start -->
  <a href="https://github.com/shekhardtu/linty/releases"><img alt="${number} downloads across all releases; checked ${date}" src="website/downloads.svg?v=${version}" /></a>
  <!-- dmg-downloads:end -->`;
  const website = `<!-- dmg-downloads:start -->
          <span data-dmg-download-count> · <a href="https://github.com/shekhardtu/linty/releases" title="Installer downloads across all published releases, including prereleases. Not unique users. Checked ${date}.">${number} downloads</a><time hidden datetime="${snapshot.checkedAt}">${date}</time></span>
          <!-- dmg-downloads:end -->`;
  return { svg, readme, website };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/update-download-count.mjs [--check]\nRefresh the README badge and lifetime landing-page snapshot from all GitHub releases.\n--check verifies generated files without network access. GITHUB_TOKEN is optional.');
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
    const options = { token: process.env.GITHUB_TOKEN };
    const releases = await fetchAllReleases(options);
    snapshot = { ...countDmgDownloads(releases), releases: releases.length, checkedAt: new Date().toISOString(), source: releasesUrl };
  }
  const rendered = renderDownloadCount(snapshot);
  const outputs = [
    ['website/downloads.json', `${JSON.stringify(snapshot, null, 2)}\n`],
    ['website/downloads.svg', rendered.svg],
    ['README.md', readme.replace(marker, rendered.readme)],
    ['website/index.html', website.replace(new RegExp(marker.source, 'g'), rendered.website)],
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
