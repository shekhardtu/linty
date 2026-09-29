// Shared by the live website and the checked-in download snapshot generator.
export const releasesUrl = 'https://api.github.com/repos/shekhardtu/linty/releases';
export const latestReleaseUrl = 'https://github.com/shekhardtu/linty/releases/latest';

async function fetchReleaseJson(suffix, { fetchImpl = fetch, token = '' } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(`${releasesUrl}${suffix}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-cache',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub releases request failed (HTTP ${response.status}); count was not updated.`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Current: linty-0.0.1.dmg and linty.dmg.
// Historical Tauri: Linty_0.0.42_aarch64.dmg and Linty_aarch64.dmg.
// Accept the corresponding Intel/universal and prerelease forms, case-insensitively.
export function parseDmgFilename(name) {
  if (typeof name !== 'string') return null;
  const match = /^linty(?<suffix>(?:[-_][a-z0-9.+_-]+)?)\.dmg$/i.exec(name);
  if (!match) return null;
  let suffix = match.groups.suffix;
  const arch = /[-_](aarch64|arm64|x86_64|x64|universal)$/i.exec(suffix);
  if (arch) suffix = suffix.slice(0, arch.index);
  const version = /^[-_]v?(\d+\.\d+\.\d+(?:-[a-z0-9-]+(?:\.[a-z0-9-]+)*)?(?:\+[a-z0-9-]+(?:\.[a-z0-9-]+)*)?)$/i.exec(suffix);
  const channel = /^[-_](alpha|beta|rc|preview|dev)$/i.exec(suffix);
  if (suffix && !version && !channel) return null;
  const architecture = arch?.[1].toLowerCase() ?? null;
  return {
    version: version?.[1] ?? null,
    architecture: ({ aarch64: 'arm64', x86_64: 'x64' })[architecture] ?? architecture,
    channel: channel?.[1].toLowerCase() ?? null,
  };
}

export function countDmgDownloads(releases) {
  let downloads = 0;
  let assets = 0;
  for (const release of releases) {
    if (release.draft) continue;
    if (!Array.isArray(release.assets)) throw new Error('GitHub returned a release without assets.');
    for (const asset of release.assets) {
      if (!parseDmgFilename(asset.name)) continue;
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

export async function fetchAllReleases({ fetchImpl = fetch, token = '' } = {}) {
  const releases = new Map();
  for (let page = 1; ; page += 1) {
    const batch = await fetchReleaseJson(`?per_page=100&page=${page}`, { fetchImpl, token });
    if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid release list.');
    for (const release of batch) {
      if (!Number.isSafeInteger(release.id)) throw new Error('GitHub returned an invalid release ID.');
      releases.set(release.id, release);
    }
    if (batch.length < 100) return [...releases.values()].filter(release => !release.draft);
  }
}

export async function fetchLatestInstaller(options) {
  // GitHub's designated latest release can differ from the first item in the list.
  const release = await fetchReleaseJson('/latest', options);
  if (!release || release.draft || release.prerelease || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name ?? '') || !Array.isArray(release.assets)) {
    throw new Error('GitHub returned an invalid stable release.');
  }
  const version = release.tag_name.replace(/^v/, '');
  for (const asset of release.assets) {
    const parsed = parseDmgFilename(asset.name);
    if (parsed?.version !== version || (parsed.architecture && parsed.architecture !== 'universal')) continue;
    const url = `https://github.com/shekhardtu/linty/releases/download/${release.tag_name}/${asset.name}`;
    if (asset.browser_download_url === url) return { version, name: asset.name, url };
  }
  throw new Error('The latest release has no versioned universal installer.');
}

export async function refreshDownloadInfo({ document: page = document, fetchImpl = fetch } = {}) {
  // Resolve independently: a failed historical page must not prevent a new download link.
  return Promise.allSettled([
    (async () => {
      const releases = await fetchAllReleases({ fetchImpl });
      const { downloads } = countDmgDownloads(releases);
      const checkedAt = new Date().toISOString();
      page.querySelectorAll('[data-dmg-download-count]').forEach(counter => {
        const link = counter.querySelector('a');
        link.textContent = `${downloads.toLocaleString('en-US')} downloads`;
        link.title = `Installer downloads across all published releases, including prereleases. Not unique users. Checked ${checkedAt.slice(0, 10)}.`;
        const time = counter.querySelector('time');
        time.dateTime = checkedAt;
        time.textContent = checkedAt.slice(0, 10);
        time.title = `Checked ${checkedAt}`;
      });
    })(),
    (async () => {
      const installer = await fetchLatestInstaller({ fetchImpl });
      // main.js removes data-download from unsupported-platform request links.
      page.querySelectorAll('[data-download], [data-mac-download]').forEach(link => { link.href = installer.url; });
    })(),
  ]);
}

// Recheck on activation as well: a page may remain open while a release ships.
export async function latestDownloadUrl(options) {
  try { return (await fetchLatestInstaller(options)).url; }
  catch { return latestReleaseUrl; }
}

