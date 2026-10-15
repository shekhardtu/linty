import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(homedir(), 'Library/Caches/linty/editor-native.noindex');
const bundle = path.join(cache, 'Linty Editor Test.app');
const resources = path.join(bundle, 'Contents/Resources');
const launcher = path.join(bundle, 'Contents/MacOS/linty-editor-test');
const manifestPath = path.join(cache, 'prepared.json');
const args = process.argv.slice(2);
const run = args.includes('--run');
const binaryIndex = args.indexOf('--test-binary');
const providedBinary = binaryIndex >= 0 ? args[binaryIndex + 1] : null;
const known = args.filter((_, index) => index !== binaryIndex + 1 || binaryIndex < 0);
if (known.some(arg => !['--prepare', '--run', '--test-binary', '--help'].includes(arg)) || (binaryIndex >= 0 && (!providedBinary || providedBinary.startsWith('--'))) || (run && (args.includes('--prepare') || providedBinary))) throw new Error('Usage: node scripts/test-editor-native.mjs [--prepare [--test-binary /absolute/test/executable] | --run]');
if (args.includes('--help')) {
  console.log('Default --prepare builds a signed isolated test app without launching it or requesting permission. --test-binary reuses an existing Rust --lib test executable. --run launches the previously prepared app and may request Accessibility access for its synthetic fixture.');
  process.exit(0);
}
if (process.platform !== 'darwin') throw new Error('The native editor rehearsal requires macOS.');
await mkdir(cache, { recursive: true, mode: 0o700 });
await chmod(cache, 0o700);
const exec = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.trim().slice(-3000)}`)));
});
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const artifacts = [launcher, path.join(resources, 'linty-editor-tests'), path.join(resources, 'editor-accessibility-fixture'), path.join(bundle, 'Contents/Info.plist')];
const sources = ['scripts/fixtures/editor-native-launcher.c', 'scripts/fixtures/correction-accessibility.swift', 'src-tauri/src/corrections/accessibility.rs', 'src-tauri/src/editor_assistance.rs'];
if (!run) {
  let testBinary = providedBinary && path.resolve(providedBinary);
  if (!testBinary) {
    const output = await exec('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--features', 'local-stt', '--locked', '--no-run', '--message-format=json']);
    const artifacts = output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    testBinary = artifacts.findLast(artifact => artifact.reason === 'compiler-artifact' && artifact.profile?.test && artifact.target?.kind?.includes('lib') && artifact.executable)?.executable;
    if (!testBinary) throw new Error('Cargo did not report a Rust library test executable.');
  }
  if (!(await stat(testBinary)).isFile()) throw new Error('The selected test executable is not a file.');
  const originalTestBinarySha256 = await hash(testBinary);
  const tests = await exec(testBinary, ['--list']);
  if (!tests.includes('corrections::accessibility::tests::native_selected_edit_rejects_stale_targets_and_preserves_surroundings: test')) throw new Error('The selected binary does not contain the exact synthetic editor test.');
  await mkdir(resources, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(launcher), { recursive: true, mode: 0o700 });
  await copyFile(testBinary, path.join(resources, 'linty-editor-tests'));
  await exec('swiftc', ['scripts/fixtures/correction-accessibility.swift', '-o', path.join(resources, 'editor-accessibility-fixture')]);
  await exec('clang', ['-Wall', '-Wextra', '-Werror', 'scripts/fixtures/editor-native-launcher.c', '-framework', 'ApplicationServices', '-framework', 'CoreFoundation', '-o', launcher]);
  await writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>linty-editor-test</string><key>CFBundleIdentifier</key><string>ai.linty.editor-test</string><key>CFBundleName</key><string>Linty Editor Test</string><key>CFBundleDisplayName</key><string>Linty Editor Test</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/></dict></plist>\n`);
  for (const file of [path.join(resources, 'linty-editor-tests'), path.join(resources, 'editor-accessibility-fixture'), launcher]) await exec('/usr/bin/codesign', ['--force', '--sign', '-', file]);
  await exec('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async file => [file, await hash(path.join(root, file))])));
  const artifactHashes = Object.fromEntries(await Promise.all(artifacts.map(async file => [path.relative(bundle, file), await hash(file)])));
  await writeFile(manifestPath, JSON.stringify({ originalTestBinarySha256, reusedTestBinary: !!providedBinary, artifactHashes, preparedAt: new Date().toISOString(), bundle, testBinary: path.join(resources, 'linty-editor-tests'), testBinarySha256: await hash(path.join(resources, 'linty-editor-tests')), sourceHashes }, null, 2));
  console.log(`Prepared and signature-verified: ${bundle}\nManifest: ${manifestPath}\nNo app was launched; no Accessibility permission was requested.`);
} else {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const file of sources) if (manifest.sourceHashes[file] !== await hash(path.join(root, file))) throw new Error('Editor test sources changed. Prepare the isolated app again before running it.');
  for (const file of artifacts) if (manifest.artifactHashes[path.relative(bundle, file)] !== await hash(file)) throw new Error('Prepared test app changed; prepare again.');
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const logDir = path.join(cache, `run-${new Date().toISOString().replaceAll(':', '-')}`);
  await mkdir(logDir, { mode: 0o700 });
  const stdout = path.join(logDir, 'stdout.log'), stderr = path.join(logDir, 'stderr.log'), resultPath = path.join(logDir, 'result.json');
  console.log(`Launching isolated synthetic test. Accessibility may be requested for Linty Editor Test. Logs: ${logDir}`);
  await exec('/usr/bin/open', ['-W', '-n', '-g', '--stdout', stdout, '--stderr', stderr, bundle, '--args', '--run', resultPath]);
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  const output = await readFile(stdout, 'utf8');
  if (!result.trusted || !result.testCompleted || result.exitCode !== 0 || !/test result: ok\. 1 passed; 0 failed;/.test(output)) throw new Error(`Native editor rehearsal did not pass. Review synthetic logs: ${logDir}`);
  console.log(`Native editor rehearsal passed (1 exact test). Evidence: ${resultPath}`);
}
