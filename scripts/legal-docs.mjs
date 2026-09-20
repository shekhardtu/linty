import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const policy = JSON.parse(await read('src/content/legal.json'));
const check = process.argv.includes('--check');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const version = async path => createHash('sha256').update(await read(path)).digest('hex').slice(0, 12);
const asset = async path => `${path}?v=${await version(`website/${path}`)}`;
export const websiteCsp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const styles = await Promise.all(['brand/theme.css', 'styles.css', 'legal.css'].map(async path => `<link rel="stylesheet" href="${await asset(path)}" />`));

for (const key of ['privacy', 'terms']) {
  const doc = policy[key];
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${websiteCsp}" />
  <meta name="referrer" content="no-referrer" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>${escape(doc.title)} — Linty</title>
  <meta name="description" content="${escape(doc.intro)}" />
  <script src="${await asset('privacy-guard.js')}"></script>
  <script src="${await asset('theme.js')}"></script>
  ${styles.join('\n  ')}
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header"><div class="container header-inner"><a class="wordmark" href="index.html">Linty</a><a href="index.html#privacy">Back to Linty</a></div></header>
  <main id="main" class="container legal-page">
    <p class="eyebrow">Linty · Updated ${escape(policy.updated)}</p>
    <h1>${escape(doc.title)}</h1>
    <p>${escape(doc.intro)}</p>
    <nav class="legal-links" aria-label="Legal documents"><a href="privacy.html">Privacy notice</a><a href="terms.html">License and responsible use</a></nav>
    <nav aria-label="On this page"><ul>${doc.sections.map(s => `<li><a href="#${escape(s.id)}">${escape(s.title)}</a></li>`).join('')}</ul></nav>
    ${doc.sections.map(s => `<section id="${escape(s.id)}" aria-labelledby="${escape(s.id)}-title"><h2 id="${escape(s.id)}-title">${escape(s.title)}</h2>${s.paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}${s.links ? `<ul>${s.links.map(l => `<li><a href="${escape(l.url)}" rel="noreferrer">${escape(l.label)}</a></li>`).join('')}</ul>` : ''}</section>`).join('\n    ')}
  </main>
</body>
</html>
`;
  const markdown = `<!-- Generated from src/content/legal.json by scripts/legal-docs.mjs. -->\n# ${doc.title}\n\nUpdated ${policy.updated}\n\n${doc.intro}\n\n${doc.sections.map(s => `## ${s.title}\n\n${s.paragraphs.join('\n\n')}${s.links ? `\n\n${s.links.map(l => `[${l.label}](${l.url})`).join(' · ')}` : ''}`).join('\n\n')}\n`;
  for (const [path, content] of [[`website/${key}.html`, html], [`${key.toUpperCase()}.md`, markdown]]) {
    if (check) {
      if (await read(path).catch(() => '') !== content) throw new Error(`${path} is stale. Run yarn legal:generate.`);
    } else await writeFile(new URL(path, root), content);
  }
}
console.log(check ? 'Legal documents match the bundled app notice.' : 'Generated website and GitHub legal documents.');
