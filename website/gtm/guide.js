const printButton = document.querySelector('[data-print]');
printButton.hidden = false;
printButton.addEventListener('click', () => window.print());

const status = document.querySelector('[data-copy-status]');
if (navigator.clipboard?.writeText) {
  document.querySelectorAll('#launch-kit blockquote').forEach((quote, index) => {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'plain-button copy-button';
    copy.textContent = 'Copy text';
    copy.setAttribute('aria-label', `Copy draft ${index + 1}`);
    const text = quote.innerText.trim();
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = 'Copied';
        status.textContent = `Draft ${index + 1} copied.`;
        window.setTimeout(() => { copy.textContent = 'Copy text'; }, 2000);
      } catch {
        status.textContent = 'Copy was unavailable. Select the draft text and copy it manually.';
      }
    });
    quote.append(copy);
  });
}

if ('IntersectionObserver' in window) {
  const links = [...document.querySelectorAll('.rail nav a')];
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const link of links) {
        if (link.hash === `#${entry.target.id}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    }
  }, { rootMargin: '-5% 0px -75% 0px' });
  document.querySelectorAll('main > section[id]').forEach(section => observer.observe(section));
}
