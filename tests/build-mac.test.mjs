import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

for (const target of [undefined, 'custom target', '/absolute']) {
  test(`standalone macOS packaging resolves ${target ?? 'default'} output before Tauri changes directory`, t => {
    const root = mkdtempSync(path.join(tmpdir(), 'linty build-path-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin'); mkdirSync(bin); mkdirSync(path.join(root, 'scripts'));
    copyFileSync(new URL('../scripts/build-mac.sh', import.meta.url), path.join(root, 'scripts/build-mac.sh'));
    writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}');
    writeFileSync(path.join(root, 'scripts/prepare-macos-dmg.mjs'), `import {appendFileSync} from 'node:fs'; appendFileSync(process.argv[2], '-prepared');`);
    const mock = (name, text) => writeFileSync(path.join(bin, name), `#!/bin/bash\nset -eu\n${text}\n`, { mode: 0o755 });
    mock('uname', 'echo Darwin'); mock('xcrun', 'exit 0'); mock('xattr', 'exit 0');
    mock('tauri', `case "$CARGO_TARGET_DIR" in /*) ;; *) exit 19 ;; esac
mkdir -p "$CARGO_TARGET_DIR/universal-apple-darwin/release/bundle/macos/Linty.app/Contents/MacOS"
mkdir -p "$CARGO_TARGET_DIR/universal-apple-darwin/release/bundle/dmg"
printf 'installer' > "$CARGO_TARGET_DIR/universal-apple-darwin/release/bundle/dmg/Linty_1.2.3_universal.dmg"`);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete env.CARGO_TARGET_DIR;
    if (target) env.CARGO_TARGET_DIR = target === '/absolute' ? path.join(root, 'absolute target') : target;
    execFileSync('bash', ['scripts/build-mac.sh', '--unsigned'], { cwd: root, env, stdio: 'pipe' });
    assert.equal(readFileSync(path.join(root, 'release/linty-1.2.3.dmg'), 'utf8'), 'installer-prepared');
    assert.equal(readFileSync(path.join(root, 'release/linty.dmg'), 'utf8'), 'installer-prepared');
  });
}
