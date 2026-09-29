import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { countDmgDownloads, fetchAllReleases, parseDmgFilename, fetchLatestInstaller, refreshDownloadInfo, latestDownloadUrl, latestReleaseUrl } from '../website/downloads.js';

test('counts every DMG filename including old versioned names and prereleases, excluding updater assets and drafts', () => {
  assert.deepEqual(countDmgDownloads([
    { assets: [
      { name: 'Linty_aarch64.dmg', download_count: 31 },
      { name: 'Linty_0.0.42_aarch64.dmg', download_count: 1 },
      { name: 'Linty_x64.DMG', download_count: 5 },
      { name: 'Linty.app.tar.gz', download_count: 80 },
      { name: 'Linty_aarch64.dmg.sig', download_count: 99 },
      { name: 'latest.json', download_count: 1000 },
      { name: 'AnotherApp.dmg', download_count: 1000 },
    ] },
    { prerelease: true, assets: [{ name: 'Linty-beta.dmg', download_count: 2 }] },
    { draft: true, assets: [{ name: 'Linty.dmg', download_count: 90 }] },
  ]), { downloads: 39, assets: 4 });
});

test('follows release pagination beyond 100 releases and avoids counting overlapping pages twice', async () => {
  const requests = [];
  const firstPage = Array.from({ length: 100 }, (_, id) => ({ id, assets: [{ name: `Linty_0.0.${id}.dmg`, download_count: 1 }] }));
  const releases = await fetchAllReleases({ token: '', fetchImpl: async url => {
    requests.push(url);
    return { ok: true, json: async () => requests.length === 1 ? firstPage : [firstPage[99], { id: 100, assets: [{ name: 'Linty_0.0.100.dmg', download_count: 7 }] }] };
  } });
  assert.equal(requests.length, 2);
  assert.ok(requests[1].endsWith('per_page=100&page=2'));
  assert.deepEqual(countDmgDownloads(releases), { downloads: 107, assets: 101 });
});

test('rejects failures and malformed data instead of publishing an incomplete or invalid count', async () => {
  await assert.rejects(fetchAllReleases({ token: '', fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
  let page = 0;
  await assert.rejects(fetchAllReleases({ token: '', fetchImpl: async () => ++page === 1
    ? { ok: true, json: async () => Array.from({ length: 100 }, (_, id) => ({ id, assets: [] })) }
    : { ok: false, status: 500 } }), /HTTP 500/);
  for (const download_count of [-1, '12', NaN, 1.5]) {
    assert.throws(() => countDmgDownloads([{ assets: [{ name: 'Linty.dmg', download_count }] }]), /invalid DMG download count/);
  }
});

test('README badge and landing-page count agree with the shared published snapshot', () => {
  const result = spawnSync(process.execPath, ['scripts/update-download-count.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('parses the published alias/versioned names and historical Tauri DMG naming formats', () => {
  for (const [name, version, architecture, channel] of [
    ['linty.dmg', null, null, null],
    ['linty-0.0.1.dmg', '0.0.1', null, null],
    ['Linty_0.0.42_aarch64.dmg', '0.0.42', 'arm64', null],
    ['Linty_aarch64.dmg', null, 'arm64', null],
    ['Linty_x64.DMG', null, 'x64', null],
    ['Linty_0.0.42_x86_64.dmg', '0.0.42', 'x64', null],
    ['Linty-v1.2.3-universal.dmg', '1.2.3', 'universal', null],
    ['linty-1.2.3-beta.2-arm64.dmg', '1.2.3-beta.2', 'arm64', null],
    ['linty-1.2.3+build.4.dmg', '1.2.3+build.4', null, null],
    ['Linty-beta.dmg', null, null, 'beta'],
  ]) assert.deepEqual(parseDmgFilename(name), { version, architecture, channel }, name);
  for (const name of ['Other.dmg', 'notlinty-1.2.3.dmg', 'linty.dmg.sig', 'linty.app.tar.gz', 'latest.json', 'linty-1.2.dmg', '../linty.dmg', 'linty-backup.dmg', '', null]) {
    assert.equal(parseDmgFilename(name), null, String(name));
  }
});

function stableRelease(version, names = [`linty-${version}.dmg`, 'linty.dmg']) {
  return { id: Number(version.split('.').at(-1)), tag_name: `v${version}`, draft: false, prerelease: false,
    assets: names.map(name => ({ name, download_count: 3, browser_download_url: `https://github.com/shekhardtu/linty/releases/download/v${version}/${name}` })) };
}
const response = data => ({ ok: true, json: async () => data });

test('resolves the actual published versioned asset using GitHub latest, never the alias or a fabricated URL', async () => {
  for (const name of ['linty-0.0.1.dmg', 'Linty_0.0.1_universal.dmg']) {
    const release = stableRelease('0.0.1', ['linty.dmg', 'Linty_0.0.1_aarch64.dmg', name]);
    const installer = await fetchLatestInstaller({ fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.github.com/repos/shekhardtu/linty/releases/latest');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.referrerPolicy, 'no-referrer');
      assert.equal(options.cache, 'no-cache');
      assert.equal(options.headers.Authorization, undefined);
      return response(release);
    } });
    assert.equal(installer.name, name);
    assert.equal(installer.url, release.assets[2].browser_download_url);
  }
  for (const release of [
    { ...stableRelease('0.0.2'), prerelease: true },
    { ...stableRelease('0.0.2'), draft: true },
    stableRelease('0.0.2', ['linty.dmg']),
    stableRelease('0.0.2', ['linty-0.0.1.dmg']),
    stableRelease('0.0.2', ['Linty_0.0.2_aarch64.dmg']),
    { ...stableRelease('0.0.2'), assets: [{ name: 'linty-0.0.2.dmg', browser_download_url: 'https://example.com/linty-0.0.2.dmg' }] },
  ]) await assert.rejects(fetchLatestInstaller({ fetchImpl: async () => response(release) }));
});

function pageFixture() {
  const counterLink = { textContent: '19 lifetime DMG downloads' };
  const time = { dateTime: '2026-09-20T00:00:00.000Z', textContent: '2026-09-20' };
  const links = [{ href: latestReleaseUrl }, { href: latestReleaseUrl }];
  const requestLink = { href: 'https://github.com/shekhardtu/linty/issues/59' };
  const document = { querySelectorAll: selector => {
    if (selector === '[data-dmg-download-count]') return [{ querySelector: tag => tag === 'a' ? counterLink : time }];
    assert.equal(selector, '[data-download], [data-mac-download]');
    return links; // Unsupported-platform links have data-download removed by main.js.
  } };
  return { document, counterLink, time, links, requestLink };
}

test('shows lifetime downloads from old releases and prereleases while linking only to designated latest', async () => {
  const page = pageFixture();
  const old = stableRelease('0.0.1', ['Linty_0.0.1_aarch64.dmg', 'Linty_aarch64.dmg']);
  old.assets[0].download_count = 900;
  const beta = { ...stableRelease('0.0.3'), prerelease: true };
  const latest = stableRelease('0.0.2');
  const results = await refreshDownloadInfo({ document: page.document, fetchImpl: async url => response(url.endsWith('/latest') ? latest : [beta, latest, old]) });
  assert.ok(results.every(result => result.status === 'fulfilled'));
  assert.equal(page.counterLink.textContent, '915 lifetime DMG downloads');
  assert.notEqual(page.time.dateTime, '2026-09-20T00:00:00.000Z');
  assert.ok(page.links.every(link => link.href.endsWith('/v0.0.2/linty-0.0.2.dmg')));
  assert.equal(page.requestLink.href, 'https://github.com/shekhardtu/linty/issues/59');
});

test('API failure preserves the dated snapshot and latest-release fallback independently', async () => {
  for (const failed of ['count', 'latest', 'both']) {
    const page = pageFixture();
    const latest = stableRelease('0.0.2');
    await refreshDownloadInfo({ document: page.document, fetchImpl: async url => {
      const isLatest = url.endsWith('/latest');
      if (failed === 'both' || (isLatest ? failed === 'latest' : failed === 'count')) return { ok: false, status: 403 };
      return response(isLatest ? latest : [latest]);
    } });
    assert.equal(page.counterLink.textContent, failed === 'latest' ? '6 lifetime DMG downloads' : '19 lifetime DMG downloads');
    assert.equal(page.links[0].href, failed === 'count' ? latest.assets[0].browser_download_url : latestReleaseUrl);
    if (failed !== 'latest') assert.equal(page.time.dateTime, '2026-09-20T00:00:00.000Z');
  }
});

test('each download activation rechecks latest and failed lookups go to latest releases rather than an old version', async () => {
  let version = '0.0.1';
  const options = { fetchImpl: async () => response(stableRelease(version)) };
  assert.match(await latestDownloadUrl(options), /\/v0.0.1\/linty-0.0.1.dmg$/);
  version = '0.0.2';
  assert.match(await latestDownloadUrl(options), /\/v0.0.2\/linty-0.0.2.dmg$/);
  assert.equal(await latestDownloadUrl({ fetchImpl: async () => { throw new Error('offline'); } }), latestReleaseUrl);
});
