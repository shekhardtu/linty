import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareMacosDmg } from '../scripts/prepare-macos-dmg.mjs';

test('macOS installer keeps its signed app intact and excludes only the mounted volume from Spotlight', { skip: process.platform !== 'darwin', timeout: 60000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'linty-installer-test-'));
  const stage = path.join(root, 'stage');
  const app = path.join(stage, 'Linty.app');
  let mount;
  const dmg = path.join(root, 'test.dmg');
  const run = (tool, args) => execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let mounted = false;
  try {
    mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
    copyFileSync('/bin/echo', path.join(app, 'Contents/MacOS/probe'));
    writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.linty.installer-test</string><key>CFBundleExecutable</key><string>probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
    run('codesign', ['--force', '--sign', '-', app]);
    const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
    const executableHash = hash(path.join(app, 'Contents/MacOS/probe'));
    symlinkSync('/Applications', path.join(stage, 'Applications'));
    run('hdiutil', ['create', '-srcfolder', stage, '-volname', `Linty Installer Test ${path.basename(root)}`, '-format', 'UDZO', dmg]);
    prepareMacosDmg(dmg, { identity: '-', run });
    run('codesign', ['--verify', '--strict', dmg]);
    // Use /Volumes, as a customer's mounted installer does. A mount under the
    // system temporary directory has no Spotlight indexing state to inspect.
    const attached = run('hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-noautoopen', '-plist']);
    const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: attached, encoding: 'utf8' }));
    mount = info['system-entities'].find(entry => entry['mount-point'])['mount-point']; mounted = true;
    assert.ok(existsSync(path.join(mount, '.metadata_never_index')));
    assert.equal(existsSync(path.join(mount, 'Linty.app/.metadata_never_index')), false);
    assert.equal(hash(path.join(mount, 'Linty.app/Contents/MacOS/probe')), executableHash);
    run('codesign', ['--verify', '--deep', '--strict', path.join(mount, 'Linty.app')]);
    assert.match(run('mdutil', ['-s', mount]), /Indexing and searching disabled/);
    assert.ok(existsSync(path.join(mount, 'Applications')));
  } finally {
    if (mounted) run('hdiutil', ['detach', mount]);
    rmSync(root, { recursive: true, force: true });
  }
});
