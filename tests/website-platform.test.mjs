import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const context = { URL };
runInNewContext(readFileSync(new URL('../website/platform.js', import.meta.url), 'utf8'), context);
const detect = context.detectDownloadPlatform;

test('every installer link serves the same universal Mac download', () => {
  const html = readFileSync(new URL('../website/index.html', import.meta.url), 'utf8');
  const downloads = [...html.matchAll(/<a\b[^>]*\bdata-(?:mac-)?download\b[^>]*>/g)];
  assert.ok(downloads.length >= 4, 'navigation, hero, fallback, and footer offer downloads');
  for (const [anchor] of downloads) {
    assert.match(anchor, /href="https:\/\/github\.com\/shekhardtu\/linty\/releases\/latest\/download\/linty\.dmg"/);
  }
  assert.match(html, /Intel and Apple silicon Macs running macOS 14 or later/);
  assert.doesNotMatch(html, /Linty_aarch64\.dmg/);
});

test('recognizes desktop client hints and legacy browser fallbacks', () => {
  for (const [platform, expected] of [['Windows', 'windows'], ['Linux', 'linux'], ['macOS', 'macos']]) {
    assert.equal(detect({ userAgentData: { platform } }), expected);
  }
  for (const [platform, expected] of [['Win32', 'windows'], ['Win64', 'windows'], ['Linux x86_64', 'linux'], ['MacIntel', 'macos']]) {
    assert.equal(detect({ platform }), expected);
  }
  assert.equal(detect({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), 'windows');
  assert.equal(detect({ userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64)' }), 'linux');
  assert.equal(detect({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), 'macos');
});

test('does not misidentify Android, iOS, or ChromeOS as desktop Linux or macOS', () => {
  assert.equal(detect({ platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), 'android');
  assert.equal(detect({ userAgentData: { platform: 'Android', mobile: true } }), 'android');
  assert.equal(detect({ platform: 'iPhone', userAgent: 'iPhone; CPU iPhone OS 17 like Mac OS X' }), 'ios');
  assert.equal(detect({ platform: 'MacIntel', maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)' }), 'ios');
  assert.equal(detect({ platform: 'Linux x86_64', userAgentData: { platform: 'Chrome OS' }, userAgent: 'Mozilla/5.0 (X11; CrOS x86_64)' }), 'chromeos');
  assert.equal(detect({ userAgentData: { mobile: true } }), 'other');
  assert.equal(detect({ userAgent: 'Windows Phone 10.0; Android 6.0.1' }), 'other');
});

test('sends Windows and Linux visitors to the shared voting issues', () => {
  for (const [platform, name, issue] of [['windows', 'Windows', 59], ['linux', 'Linux', 60]]) {
    const request = context.getPlatformRequest(platform);
    assert.equal(request.name, name);
    assert.equal(request.url, `https://github.com/shekhardtu/linty/issues/${issue}`);
    assert.equal(request.shared, true);
  }
});

test('prefills the feature form for other platforms without privileged label parameters', () => {
  for (const [platform, name] of [['android', 'Android'], ['ios', 'iOS'], ['chromeos', 'ChromeOS'], ['other', 'another OS']]) {
    const request = context.getPlatformRequest(platform);
    assert.equal(request.name, name);
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://github.com');
    assert.equal(url.pathname, '/shekhardtu/linty/issues/new');
    assert.equal(url.searchParams.get('template'), 'feature_request.yml');
    assert.equal(url.searchParams.get('title'), `[Platform request] ${name}`);
    assert.ok(url.searchParams.get('problem').includes(name));
    assert.ok(url.searchParams.get('suggestion').includes(name));
    assert.equal(url.searchParams.has('labels'), false);
    assert.equal(Boolean(request.shared), false);
  }
  assert.equal(context.getPlatformRequest('macos'), null);
  assert.equal(context.getPlatformRequest('unknown'), null);
});

test('keeps unidentified and non-Linux Unix devices unknown', () => {
  assert.equal(detect(), 'unknown');
  assert.equal(detect({ platform: '', userAgent: '' }), 'unknown');
  assert.equal(detect({ platform: 'FreeBSD amd64', userAgent: 'Mozilla/5.0 (X11; FreeBSD amd64)' }), 'unknown');
  assert.equal(detect({ platform: 'MacIntel', maxTouchPoints: 0 }), 'macos');
});
