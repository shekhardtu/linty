import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { countDmgDownloads, fetchAllReleases } from '../scripts/update-download-count.mjs';

test('counts every DMG filename including old versioned names and prereleases, excluding updater assets and drafts', () => {
  assert.deepEqual(countDmgDownloads([
    { assets: [
      { name: 'Linty_aarch64.dmg', download_count: 31 },
      { name: 'Linty_0.0.42_aarch64.dmg', download_count: 1 },
      { name: 'Linty_x64.DMG', download_count: 5 },
      { name: 'Linty.app.tar.gz', download_count: 80 },
      { name: 'Linty_aarch64.dmg.sig', download_count: 99 },
      { name: 'latest.json', download_count: 1000 },
    ] },
    { prerelease: true, assets: [{ name: 'Linty-beta.dmg', download_count: 2 }] },
    { draft: true, assets: [{ name: 'Linty.dmg', download_count: 90 }] },
  ]), { downloads: 39, assets: 4 });
});

test('follows release pagination beyond 100 releases and avoids counting overlapping pages twice', async () => {
  const requests = [];
  const firstPage = Array.from({ length: 100 }, (_, id) => ({ id, assets: [{ name: `Linty_${id}.dmg`, download_count: 1 }] }));
  const releases = await fetchAllReleases({ token: '', fetchImpl: async url => {
    requests.push(url);
    return { ok: true, json: async () => requests.length === 1 ? firstPage : [firstPage[99], { id: 100, assets: [{ name: 'Linty_old.dmg', download_count: 7 }] }] };
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
