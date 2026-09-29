#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Change only the installer volume, never the signed app inside it. An exclusion
// inside Linty.app would follow the app into Applications and hide the installed app.
export function prepareMacosDmg(image, { identity, run = command } = {}) {
  const original = path.resolve(image);
  if (path.extname(original) !== '.dmg' || !existsSync(original)) throw new Error('Expected an existing DMG.');
  const scratch = mkdtempSync(path.join(path.dirname(original), '.installer.noindex-'));
  const writable = path.join(scratch, 'writable.dmg');
  const prepared = path.join(scratch, 'prepared.dmg');
  const mount = path.join(scratch, 'volume');
  mkdirSync(mount);
  let mounted = false;
  try {
    run('hdiutil', ['convert', original, '-format', 'UDRW', '-o', writable]);
    mounted = true;
    run('hdiutil', ['attach', writable, '-readwrite', '-nobrowse', '-noautoopen', '-mountpoint', mount]);
    writeFileSync(path.join(mount, '.metadata_never_index'), '');
    // Discard only a possible index carried by this generated installer volume.
    rmSync(path.join(mount, '.Spotlight-V100'), { recursive: true, force: true });
    run('hdiutil', ['detach', mount]);
    mounted = false;
    run('hdiutil', ['convert', writable, '-format', 'UDZO', '-o', prepared]);
    run('hdiutil', ['verify', prepared]);
    mounted = true;
    run('hdiutil', ['attach', prepared, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount]);
    if (!existsSync(path.join(mount, '.metadata_never_index'))) throw new Error('Installer Spotlight exclusion is missing.');
    if (existsSync(path.join(mount, 'Linty.app/.metadata_never_index'))) throw new Error('The installed app must remain searchable.');
    run('hdiutil', ['detach', mount]);
    mounted = false;
    if (identity) {
      run('codesign', ['--force', '--sign', identity, prepared]);
      run('codesign', ['--verify', '--strict', prepared]);
    }
    // Keep the original available until conversion and signing both succeed.
    renameSync(prepared, original);
  } finally {
    if (mounted) {
      // Do not recursively delete a still-mounted filesystem if detach fails.
      run('hdiutil', ['detach', mount]);
      mounted = false;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

function command(tool, args) {
  const result = spawnSync(tool, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${tool} failed while preparing the installer: ${result.stderr || result.error?.message || result.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.platform !== 'darwin' || process.argv.length !== 3) throw new Error('Usage on macOS: node scripts/prepare-macos-dmg.mjs INSTALLER.dmg');
    prepareMacosDmg(process.argv[2], { identity: process.env.APPLE_SIGNING_IDENTITY });
    console.log('Installer volume excluded from Spotlight; installed app remains searchable.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
