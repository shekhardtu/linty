// Apply before paint so a saved choice does not flash the opposite theme.
(() => {
  let theme;
  try { theme = localStorage.getItem('linty-site-theme'); } catch {}
  document.documentElement.dataset.theme = ['light', 'dark'].includes(theme)
    ? theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
})();
