/* Best-effort OS detection, used only to choose a link. Nothing is recorded here. */
function detectDownloadPlatform(browser = {}) {
  const hint = String(browser.userAgentData?.platform || '').toLowerCase();
  const platform = String(browser.platform || '').toLowerCase();
  const agent = String(browser.userAgent || '').toLowerCase();

  const signals = `${hint} ${platform} ${agent}`;
  if (/windows phone/.test(signals)) return 'other';
  if (/android/.test(signals)) return 'android';
  if (/iphone|ipad|ipod|\bios\b/.test(signals)
    || (platform.startsWith('mac') && browser.maxTouchPoints > 1)) return 'ios';
  if (hint === 'chrome os' || /cros/.test(agent)) return 'chromeos';
  if (browser.userAgentData?.mobile) return 'other';

  if (hint === 'windows') return 'windows';
  if (hint === 'linux') return 'linux';
  if (hint === 'macos') return 'macos';
  if (/^win/.test(platform) || /windows nt/.test(agent)) return 'windows';
  if (/linux/.test(platform) || /linux|ubuntu/.test(agent)) return 'linux';
  if (/^mac/.test(platform) || /macintosh|mac os x/.test(agent)) return 'macos';
  return 'unknown';
}

function getPlatformRequest(platform) {
  const names = { windows: 'Windows', linux: 'Linux', android: 'Android', ios: 'iOS', chromeos: 'ChromeOS', other: 'another OS' };
  const name = names[platform];
  if (!name) return null;
  const sharedIssues = { windows: 59, linux: 60 };
  if (sharedIssues[platform]) {
    return { name, url: `https://github.com/shekhardtu/linty/issues/${sharedIssues[platform]}`, shared: true };
  }
  const url = new URL('https://github.com/shekhardtu/linty/issues/new');
  url.searchParams.set('template', 'feature_request.yml');
  url.searchParams.set('title', `[Platform request] ${name}`);
  url.searchParams.set('problem', `I use ${name} and would like to use Linty for dictation.`);
  url.searchParams.set('suggestion', `Please add support for ${name}.`);
  return { name, url: url.href };
}
