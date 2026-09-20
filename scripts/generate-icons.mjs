// Linty's three-stroke mark is drawn once, in src/assets/linty-mark.svg.
// Generate platform containers and formats; do not redraw the symbol in each UI.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Command, Cpu } from 'lucide-react';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = join(root, 'src-tauri/icons/manifest.json');
const sources = ['src/assets/linty-mark.svg', 'src/assets/brand-artwork.json', 'src/styles/tokens.css', 'scripts/generate-icons.mjs', 'yarn.lock'];
const hash = async (path) => createHash('sha256').update(await readFile(join(root, path))).digest('hex');
if (process.argv.includes('--check')) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const stale = [];
  for (const [path, expected] of Object.entries({ ...manifest.sources, ...manifest.outputs })) {
    if (await hash(path).catch(() => null) !== expected) stale.push(path);
  }
  if (stale.length) throw new Error(`Brand assets are out of sync. Run yarn icons:generate.\n${stale.join('\n')}`);
  console.log('Brand sources and all generated icon/theme assets are in sync.');
  process.exit(0);
}

const mark = (await readFile(join(root, sources[0]), 'utf8')).trim();
const artwork = JSON.parse(await readFile(join(root, 'src/assets/brand-artwork.json'), 'utf8'));
const tokens = await readFile(join(root, 'src/styles/tokens.css'), 'utf8');
const appAccent = tokens.match(/--palette-light-accent:\s*(#[0-9a-f]{6});/i)?.[1];
if (!appAccent || !tokens.includes('@theme {') || !tokens.includes(':root[data-theme="light"] {')) {
  throw new Error('Theme token structure changed; update the website theme conversion.');
}
// Reuse the application's tokens as plain CSS. The website follows the OS theme
// with an optional website preference, instead of the desktop app's store.
const websiteTheme = '/* Generated from src/styles/tokens.css. Run yarn icons:generate; do not edit. */\n'
  + tokens.replace('@theme {', ':root {').replace(
    /:root\[data-theme="light"\] \{([^}]+)\}/,
    '@media (prefers-color-scheme: light) {\n  :root:not([data-theme="dark"]) {$1}\n}\n:root[data-theme="light"] {$1}',
  );
// Strip the outer element only; every use retains the canonical viewBox and shapes.
const body = mark.replace(/^<svg\b[^>]*>/, '').replace(/<\/svg>$/, '').trim();
const viewBox = mark.match(/viewBox="([^"]+)"/)[1];
const symbol = (x, y, width, height, color) => `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${viewBox}" fill="${color}">${body}</svg>`;
const appSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <path d="M320 96H704C862 96 928 162 928 320V704C928 862 862 928 704 928H320C162 928 96 862 96 704V320C96 162 162 96 320 96Z" fill="${appAccent}"/>
  ${symbol(302, 272, 420, 480, '#ffffff')}
</svg>\n`;
const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">${symbol(4, 3, 14, 16, 'black')}</svg>\n`;
const staging = await mkdtemp(join(tmpdir(), 'linty-icons-'));
const outputs = [];
const write = async (path, content) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
  outputs.push(path);
};
const copy = async (from, to) => { await mkdir(dirname(join(root, to)), { recursive: true }); await cp(from, join(root, to)); outputs.push(to); };
const icon = (...args) => execFileSync(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', ...args], { cwd: root, stdio: 'pipe' });
try {
  const input = join(staging, 'app.svg');
  await writeFile(input, appSvg);
  const appOutput = join(staging, 'app');
  icon(input, '--output', appOutput);
  // Only retain formats consumed by this desktop app; no unused mobile/store assets.
  for (const name of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.icns', 'icon.ico']) {
    await copy(join(appOutput, name), `src-tauri/icons/${name}`);
  }
  const pngOutput = join(staging, 'png');
  icon(input, '--output', pngOutput, '--png', '1024', '--png', '180');
  await copy(join(pngOutput, '1024x1024.png'), 'src-tauri/icons/icon.png');
  await write('src-tauri/icons/icon.svg', appSvg);
  await write('src-tauri/icons/tray-icon.svg', traySvg);
  const trayInput = join(staging, 'tray.svg');
  await writeFile(trayInput, traySvg);
  const trayOutput = join(staging, 'tray');
  icon(trayInput, '--output', trayOutput, '--png', '22', '--png', '44');
  await copy(join(trayOutput, '22x22.png'), 'src-tauri/icons/tray-icon@1x.png');
  await copy(join(trayOutput, '44x44.png'), 'src-tauri/icons/tray-icon.png');
  for (const directory of ['public/brand', 'website/brand']) {
    await write(`${directory}/icon.svg`, appSvg);
    await copy(join(appOutput, '32x32.png'), `${directory}/favicon.png`);
    await copy(join(pngOutput, '180x180.png'), `${directory}/apple-touch-icon.png`);
  }
  await write('website/brand/mark.svg', `${mark}\n`);
  // Match the exact Lucide components used by the app, including stroke weight.
  for (const [name, component] of [['cpu', Cpu], ['command', Command]]) {
    await write(`website/brand/${name}.svg`, `${renderToStaticMarkup(createElement(component, { size: 24 }))}\n`);
  }
  const stroke = 'fill="none" stroke="black" stroke-width="1" vector-effect="non-scaling-stroke"';
  await write('website/brand/flow.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${artwork.flow.viewBox}">${artwork.flow.paths.map(path => `<path d="${path}" ${stroke}/>`).join('')}</svg>\n`);
  await write('website/brand/contour.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${artwork.contour.viewBox}"><g transform="${artwork.contour.transform}">${artwork.contour.ellipses.map(ellipse => `<ellipse ${Object.entries(ellipse).map(([key, value]) => `${key}="${value}"`).join(' ')} ${stroke}/>`).join('')}</g></svg>\n`);
  await write('website/brand/theme.css', websiteTheme);
  const hashes = async (paths) => Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await hash(path)])));
  await writeFile(manifestPath, `${JSON.stringify({ sources: await hashes(sources), outputs: await hashes(outputs.sort()) }, null, 2)}\n`);
  console.log(`Generated ${outputs.length} brand assets from the shared Linty mark and theme.`);
} finally { await rm(staging, { recursive: true, force: true }); }
