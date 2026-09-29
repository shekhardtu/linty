import { refreshDownloadInfo, latestDownloadUrl, latestReleaseUrl } from './downloads.js?v=065518fbb4b5';

/* Static product page. Its walkthrough is an illustration, not a speech benchmark. */
(() => {
  const root = document.documentElement;
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  let explicitTheme = false;
  try { explicitTheme = ['light', 'dark'].includes(localStorage.getItem('linty-site-theme')); } catch {}
  const setTheme = (theme, remember = false) => {
    root.dataset.theme = theme;
    document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme)));
    if (remember) {
      explicitTheme = true;
      try { localStorage.setItem('linty-site-theme', theme); } catch {}
    }
  };
  setTheme(root.dataset.theme || (systemTheme.matches ? 'dark' : 'light'));
  document.querySelectorAll('[data-theme-choice]').forEach(button => button.addEventListener('click', () => setTheme(button.dataset.themeChoice, true)));
  systemTheme.addEventListener('change', event => { if (!explicitTheme) setTheme(event.matches ? 'dark' : 'light'); });

  // Visitors vote on shared issues or submit a new request on GitHub.
  const platformRequest = typeof detectDownloadPlatform === 'function'
    ? getPlatformRequest(detectDownloadPlatform(navigator)) : null;
  if (platformRequest) {
    document.querySelectorAll('[data-download]').forEach(link => {
      link.href = platformRequest.url;
      link.removeAttribute('data-download');
      link.setAttribute('aria-label', `Request Linty for ${platformRequest.name} on GitHub`);
      const label = link.querySelector('.download-label > span:first-child');
      if (label) label.textContent = link.classList.contains('button-small') ? 'Request Linty' : `Request for ${platformRequest.name}`;
      const symbol = link.querySelector('.download-symbol');
      if (symbol) symbol.textContent = '↗';
    });
    document.querySelectorAll('[data-download-note]').forEach(note => {
      note.textContent = platformRequest.shared
        ? `Available for Mac today. Add 👍 on GitHub to request ${platformRequest.name}; sign-in required.`
        : 'Available for Mac today. Requests open on GitHub; sign-in required.';
    });
    document.querySelectorAll('[data-mac-download]').forEach(link => { link.hidden = false; });
  }

  // Resolve the latest installer again on activation, including long-lived tabs.
  // Transfer progress belongs to the browser; this only acknowledges the handoff.
  const downloadStatus = document.getElementById('download-status');
  const pendingDownloads = new Map();
  document.querySelectorAll('[data-download], [data-mac-download]').forEach(link => {
    const originalLabel = link.getAttribute('aria-label');
    const reset = () => {
      clearTimeout(pendingDownloads.get(link)?.timer);
      pendingDownloads.delete(link);
      link.classList.remove('is-downloading');
      link.removeAttribute('aria-busy');
      link.removeAttribute('aria-disabled');
      if (originalLabel === null) link.removeAttribute('aria-label');
      else link.setAttribute('aria-label', originalLabel);
    };
    link.addEventListener('click', async event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (pendingDownloads.has(link)) return;
      link.classList.add('is-downloading');
      link.setAttribute('aria-busy', 'true');
      link.setAttribute('aria-disabled', 'true');
      link.setAttribute('aria-label', 'Starting Linty download');
      downloadStatus.textContent = 'Starting your Linty download. Check your browser’s downloads for progress.';
      const pending = { timer: null, reset };
      pendingDownloads.set(link, pending);
      const url = await latestDownloadUrl();
      if (pendingDownloads.get(link) !== pending) return;
      link.href = url;
      if (url === latestReleaseUrl) downloadStatus.textContent = 'Opening the latest Linty release on GitHub.';
      window.location.assign(url);
      pending.timer = setTimeout(reset, 5000);
    });
  });
  void refreshDownloadInfo();
  addEventListener('pageshow', () => {
    for (const { reset } of pendingDownloads.values()) reset();
  });
})();
