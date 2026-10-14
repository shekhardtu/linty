import { constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './run-tasks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// generate_context reads the canonical config in its directory; specifying a
// different filename alone does not select another config. Use the same
// explicit merge mechanism as the Tauri CLI for both build.rs and codegen.
const env = {
  ...process.env,
  TAURI_CONFIG: readFileSync(path.join(root, 'src-tauri/tauri.recovery-test.conf.json'), 'utf8'),
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? path.join(root, 'src-tauri/target/capsule-recovery.noindex'),
};
mkdirSync(env.CARGO_TARGET_DIR, { recursive: true });
const reportDir = mkdtempSync(path.join(env.CARGO_TARGET_DIR, 'capsule-recovery-report-'));
env.LINTY_CAPSULE_RECOVERY_REPORT = path.join(reportDir, 'result.json');

try {
  if (process.platform !== 'darwin') throw new Error('The native capsule rehearsal requires macOS.');
  await runCommand('yarn', ['build'], { cwd: root });
  await runCommand('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml',
    '--example', 'capsule_recovery_smoke', '--features', 'local-stt,capsule-recovery-test', '--locked'],
  { cwd: root, env });
  const bundle = path.join(reportDir, 'Linty Recovery Test.app');
  const macos = path.join(bundle, 'Contents/MacOS');
  mkdirSync(macos, { recursive: true });
  const executable = path.join(macos, 'capsule_recovery_smoke');
  copyFileSync(path.join(env.CARGO_TARGET_DIR, 'debug/examples/capsule_recovery_smoke'), executable, constants.COPYFILE_FICLONE);
  writeFileSync(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>capsule_recovery_smoke</string>
<key>CFBundleIdentifier</key><string>ai.linty.recovery-test</string>
<key>CFBundleName</key><string>Linty Recovery Test</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
  await runCommand('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { cwd: root });
  console.log(`Isolated test app: ${bundle}`);
  await runCommand(executable, [], { cwd: root, env });
  const report = JSON.parse(readFileSync(env.LINTY_CAPSULE_RECOVERY_REPORT, 'utf8'));
  if (report.passed !== true) throw new Error('Native recovery rehearsal did not pass.');
  console.log(`Native recovery evidence: ${env.LINTY_CAPSULE_RECOVERY_REPORT}`);
  if (!env.LINTY_RECOVERY_INSPECT) rmSync(bundle, { recursive: true });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
