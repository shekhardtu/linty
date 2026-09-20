#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { nextVersion } from './prepare-release.mjs';

const repository = 'shekhardtu/linty';
const target = 'aarch64-apple-darwin';
const versionPattern = /^\d+\.\d+\.\d+$/;
const signingNames = ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID',
  'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'];

export function parseArgs(args) {
  const options = { mode: '--check', releaseType: undefined, bump: 'patch', help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const key = ['--check', '--build-only', '--publish'].includes(arg) ? 'mode' : arg;
    if (seen.has(key)) throw new Error(`Repeated or conflicting option: ${arg}`);
    seen.add(key);
    if (key === 'mode') options.mode = arg;
    else if (arg === '--help') options.help = true;
    else if (arg === '--release-type') {
      options.releaseType = args[++index];
      if (!['required', 'optional'].includes(options.releaseType)) throw new Error('--release-type requires required or optional.');
    } else if (arg === '--bump') {
      options.bump = args[++index];
      if (!['patch', 'minor', 'major'].includes(options.bump)) throw new Error('--bump requires patch, minor, or major.');
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export async function selectReleaseType(options, ask) {
  if (options.releaseType) return options.releaseType;
  if (options.mode !== '--publish') return 'optional';
  const answer = (await ask('Is this release required or an optional upgrade? Type required or optional: ')).trim().toLowerCase();
  if (!['required', 'optional'].includes(answer)) throw new Error('Choose required or optional before publishing; there is no default.');
  return answer;
}

export function requireCleanMain(git) {
  if (git(['branch', '--show-current']).trim() !== 'main') throw new Error('Run deployment from a main worktree.');
  if (git(['status', '--porcelain']).trim()) throw new Error('Commit or move changes from the main worktree before deployment.');
}

export function synchronizeMain(git) {
  requireCleanMain(git);
  git(['fetch', 'origin', 'main', '--tags']);
  // Rebase only unpublished local commits. A conflict restores the original
  // clean main and stops; neither a force push nor a conflict guess is allowed.
  try {
    git(['rebase', 'origin/main']);
  } catch {
    try { git(['rebase', '--abort']); } catch { /* Rebase may not have started. */ }
    throw new Error('Main could not be synchronized. Resolve its conflicts before deploying.');
  }
  try {
    git(['push', 'origin', 'HEAD:refs/heads/main']);
  } catch {
    throw new Error('Main push was rejected. Merge local commits through a checked PR if branch protection requires it, then deploy again.');
  }
  git(['fetch', 'origin', 'main', '--tags']);
  const sha = git(['rev-parse', 'HEAD']).trim();
  assertMainMatches(git, sha);
  return sha;
}

export function assertMainMatches(git, sha) {
  requireCleanMain(git);
  if (git(['rev-parse', 'HEAD']).trim() !== sha || git(['rev-parse', 'origin/main']).trim() !== sha) {
    throw new Error('Local main, remote main, and the build source must match. Main changed; synchronize and rebuild.');
  }
}

export function updaterManifest({ version, notes, signature, archive, previous, releaseType = 'optional', now = new Date() }) {
  if (!['required', 'optional'].includes(releaseType)) throw new Error('Unknown release type.');
  if (!versionPattern.test(version) || !signature.trim() || path.basename(archive) !== archive) {
    throw new Error('Invalid release version, updater signature, or archive name.');
  }
  const minimum = releaseType === 'required' ? version : previous.minimum_version;
  if (minimum !== undefined && (!versionPattern.test(minimum) ||
      nextVersion(version, [minimum]) !== nextVersion(version, []))) {
    throw new Error('The previous minimum update version is invalid or newer than this release.');
  }
  return {
    version: `v${version}`, notes, pub_date: now.toISOString(),
    platforms: { 'darwin-aarch64': { signature: signature.trim(),
      url: `https://github.com/${repository}/releases/download/v${version}/${archive}` } },
    ...(minimum === undefined ? {} : { minimum_version: minimum }),
  };
}

export function publishBuiltRelease({ git, gh, sourceSha, builtSha, version, buildDir, requireLocalPublisher, upload }) {
  requireLocalPublisher();
  git(['fetch', 'origin', 'main', '--tags']);
  assertMainMatches(git, sourceSha);
  if (git(['rev-parse', `${builtSha}^`]).trim() !== sourceSha) throw new Error('The built version commit has a different source.');
  const tags = git(['tag', '--list']).trim().split('\n');
  if (!versionPattern.test(version) || tags.some(tag => tag.replace(/^v/, '') === version) ||
      nextVersion(version, tags) !== nextVersion(version, [])) {
    throw new Error('Release tags changed during the build; choose a fresh version and rebuild.');
  }
  const tag = `v${version}`;
  git(['tag', tag, builtSha]);
  git(['push', 'origin', `refs/tags/${tag}`]);
  gh(['release', 'create', tag, '--repo', repository, '--verify-tag', '--draft',
    '--title', `Linty ${tag}`, '--notes-file', path.join(buildDir, 'RELEASE_NOTES.md')]);
  upload(tag);
}

async function main(options) {
  if (options.help) {
    console.log('Usage: yarn release:local [--check | --build-only | --publish] [--release-type required|optional] [--bump patch|minor|major]\n' +
      'Run from clean main on an Apple Silicon Mac. Defaults to a read-only prerequisite check.\n' +
      'Publishing asks required or optional unless that choice is supplied explicitly. Version bumps default to patch.\n' +
      'Build/publish synchronize and push main first; all builds and tests run locally.');
    return;
  }
  if (process.env.GITHUB_ACTIONS === 'true') throw new Error('Local releases cannot run in GitHub Actions.');
  const root = process.cwd();
  const baseEnv = { ...process.env };
  for (const key of [...signingNames, 'GH_TOKEN', 'GITHUB_TOKEN', 'LINTY_PARAKEET_LIB_DIR', 'CARGO_BUILD_TARGET']) delete baseEnv[key];
  const ghEnv = { ...baseEnv, GH_REPO: repository };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) if (process.env[key]) ghEnv[key] = process.env[key];
  const run = (command, args, { cwd = root, env = baseEnv, capture = false } = {}) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    // Never include command arguments: notarization arguments contain secrets.
    if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed${result.status === null ? '' : ` (exit ${result.status})`}.`);
    return result.stdout ?? '';
  };
  const git = args => run('git', args, { capture: true });
  const gh = args => run('gh', args, { env: ghEnv, capture: true });
  const requireLocalPublisher = () => {
    const workflow = JSON.parse(gh(['api', `repos/${repository}/actions/workflows/build-dmg.yml`]));
    if (workflow.state !== 'disabled_manually') throw new Error('Disable build-dmg.yml before local publishing to avoid competing releases.');
    const runs = JSON.parse(gh(['run', 'list', '--repo', repository, '--workflow', 'build-dmg.yml', '--limit', '100', '--json', 'status']));
    if (runs.some(item => item.status !== 'completed')) throw new Error('Wait for the existing remote release run to finish before deploying locally.');
  };
  requireCleanMain(git);
  const remote = git(['remote', 'get-url', 'origin']).trim();
  if (!/^(?:git@github\.com:|https:\/\/github\.com\/)shekhardtu\/linty(?:\.git)?$/.test(remote)) {
    throw new Error(`origin must point to ${repository}.`);
  }
  if (run('uname', ['-s'], { capture: true }).trim() !== 'Darwin' || run('uname', ['-m'], { capture: true }).trim() !== 'arm64') {
    throw new Error('Official local releases require an Apple Silicon Mac.');
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or later is required.');
  const python = process.env.LINTY_RELEASE_PYTHON || 'python3.13';
  run(python, ['-c', 'import sys; assert sys.version_info >= (3, 12)']);
  for (const [command, args] of [['yarn', ['--version']], ['cargo', ['--version']], ['swift', ['--version']],
    ['xcodebuild', ['-version']], ['minisign', ['-v']]]) run(command, args, { capture: true });
  const missing = signingNames.filter(name => name === 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'
    ? !Object.hasOwn(process.env, name) : !process.env[name]);
  if (missing.length) throw new Error(`Export release credentials: ${missing.join(', ')}. Values are never printed or stored.`);
  const identities = run('security', ['find-identity', '-v', '-p', 'codesigning'], { capture: true });
  if (!identities.includes(`"${process.env.APPLE_SIGNING_IDENTITY}"`)) throw new Error('The signing identity and private key must be installed in Keychain.');
  requireLocalPublisher();
  if (options.mode === '--check') {
    const remoteSha = git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
    console.log(git(['rev-parse', 'HEAD']).trim() === remoteSha ? 'Local and remote main match.' : 'Build/publish will synchronize local and remote main first.');
    console.log('Local release prerequisites passed. Nothing was built or published.');
    return;
  }
  const releaseType = await selectReleaseType(options, async question => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Ask the user for this release type, then pass --release-type required or optional.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { return await prompt.question(question); } finally { prompt.close(); }
  });

  const commonGit = path.resolve(root, git(['rev-parse', '--git-common-dir']).trim());
  const storage = path.resolve(commonGit, '..', 'release', 'local');
  mkdirSync(storage, { recursive: true });
  const lock = path.join(storage, '.lock');
  try { mkdirSync(lock); } catch { throw new Error(`Another local release may be running. Check ${lock} before retrying.`); }
  let buildDir;
  try {
    console.log('Synchronizing main and pushing its commits...');
    const sourceSha = synchronizeMain(git);
    buildDir = mkdtempSync(path.join(storage, 'build-'));
    git(['worktree', 'add', '--detach', buildDir, sourceSha]);
    const buildGit = args => run('git', args, { cwd: buildDir, capture: true });
    const version = run(process.execPath, ['scripts/prepare-release.mjs', '--bump', options.bump,
      ...(options.mode === '--build-only' ? ['--build-only'] : [])],
      { cwd: buildDir, capture: true }).trim();
    if (!versionPattern.test(version)) throw new Error('Release preparation did not return a valid version.');
    buildGit(['add', 'package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']);
    buildGit(['-c', 'user.name=Linty Release', '-c', 'user.email=release@linty.local', 'commit', '-m', `chore: release v${version}`]);
    const builtSha = buildGit(['rev-parse', 'HEAD']).trim();
    mkdirSync(path.join(buildDir, 'release'), { recursive: true });
    const cache = path.join(storage, 'cache');
    const targetDir = path.join(cache, 'target');
    const swiftDir = path.join(cache, 'swift-bridge');
    const venv = path.join(cache, 'python');
    const env = { ...baseEnv, CARGO_TARGET_DIR: targetDir };
    const build = (command, args, extra = {}) => run(command, args, { cwd: buildDir, env, ...extra });
    console.log(`Preparing ${releaseType} v${version} (${options.bump} bump) from main ${sourceSha}. Saved worktree: ${buildDir}`);
    build('yarn', ['install', '--frozen-lockfile', '--ignore-scripts']);
    build('swift', ['build', '-c', 'release', '--product', 'LintyParakeet', '--package-path', 'src-tauri/swift',
      '--scratch-path', swiftDir, '--disable-automatic-resolution']);
    env.LINTY_PARAKEET_LIB_DIR = build('swift', ['build', '-c', 'release', '--show-bin-path', '--package-path', 'src-tauri/swift', '--scratch-path', swiftDir], { capture: true }).trim();
    build('xcrun', ['lipo', path.join(env.LINTY_PARAKEET_LIB_DIR, 'libLintyParakeet.a'), '-verify_arch', 'arm64']);
    build(python, ['-m', 'venv', venv]);
    const py = path.join(venv, 'bin', 'python');
    build(py, ['-m', 'pip', 'install', '-r', 'scripts/benchmarks/public-requirements.txt']);
    console.log('Running the complete check suite locally on the versioned release source...');
    build(py, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'public_corpus_test.py', '-v']);
    build('bash', ['scripts/check-rust-logging.sh']);
    build('yarn', ['test']);
    build('yarn', ['build']);
    build('yarn', ['audit']);
    build(py, ['scripts/third-party-notices.py', '--check']);
    build('cargo', ['fmt', '--check', '--manifest-path', 'src-tauri/Cargo.toml']);
    build('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--target', target, '--features', 'local-stt,parakeet']);
    build('swift', ['test', '--package-path', 'src-tauri/swift', '--scratch-path', path.join(cache, 'swift-tests'), '--disable-automatic-resolution']);
    build(py, ['tests/supervisor.test.py']);
    build(py, ['scripts/check-rust-advisories.py']);
    build('yarn', ['playwright', 'install', 'chromium', 'webkit']);
    for (const browser of ['chromium', 'webkit']) for (const suite of ['security', 'ui', 'audio-history', 'correction-feedback', 'updates']) {
      build('yarn', [`test:${suite}`], { env: { ...env, UI_BROWSER: browser } });
    }

    const bundle = path.join(targetDir, target, 'release', 'bundle');
    rmSync(bundle, { recursive: true, force: true }); // Only this command's dedicated output cache.
    const signedEnv = { ...env, ...Object.fromEntries(signingNames.map(name => [name, process.env[name]])) };
    console.log('Building, signing, and notarizing locally...');
    build('yarn', ['tauri', 'build', '--target', target, '--bundles', 'dmg,app', '--features', 'local-stt,parakeet'], { env: signedEnv });
    const one = (directory, extension) => {
      const matches = readdirSync(directory).filter(name => name.endsWith(extension));
      if (matches.length !== 1) throw new Error(`Expected one ${extension} in ${directory}.`);
      return path.join(directory, matches[0]);
    };
    const app = path.join(bundle, 'macos', 'Linty.app');
    const dmg = one(path.join(bundle, 'dmg'), '.dmg');
    const archive = one(path.join(bundle, 'macos'), '.app.tar.gz');
    const signature = `${archive}.sig`;
    build('codesign', ['--verify', '--deep', '--strict', app]);
    build('xcrun', ['stapler', 'validate', app]);
    build('xcrun', ['notarytool', 'submit', dmg, '--apple-id', process.env.APPLE_ID,
      '--password', process.env.APPLE_PASSWORD, '--team-id', process.env.APPLE_TEAM_ID, '--wait']);
    build('xcrun', ['stapler', 'staple', dmg]);
    build('xcrun', ['stapler', 'validate', dmg]);
    const config = JSON.parse(readFileSync(path.join(buildDir, 'src-tauri/tauri.conf.json'), 'utf8'));
    const publicKey = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8');
    const decodedSignature = Buffer.from(readFileSync(signature, 'utf8').trim(), 'base64').toString('utf8');
    if (!publicKey.startsWith('untrusted comment:') || !decodedSignature.startsWith('untrusted comment:')) throw new Error('Invalid updater key or signature encoding.');
    writeFileSync(path.join(buildDir, 'release/updater.pub'), publicKey);
    writeFileSync(path.join(buildDir, 'release/updater.minisig'), decodedSignature);
    build('minisign', ['-V', '-m', archive, '-p', 'release/updater.pub', '-x', 'release/updater.minisig']);

    const staged = path.join(buildDir, 'src-tauri/target/release/bundle');
    mkdirSync(path.join(staged, 'dmg'), { recursive: true });
    mkdirSync(path.join(staged, 'macos'), { recursive: true });
    const files = [
      ['src-tauri/target/release/bundle/dmg/Linty_aarch64.dmg', dmg],
      [`src-tauri/target/release/bundle/macos/${path.basename(archive)}`, archive],
      [`src-tauri/target/release/bundle/macos/${path.basename(signature)}`, signature],
    ];
    for (const [destination, original] of files) copyFileSync(original, path.join(buildDir, destination));
    const previousDir = path.join(buildDir, 'release/previous');
    mkdirSync(previousDir, { recursive: true });
    const previousTag = JSON.parse(gh(['release', 'view', '--repo', repository, '--json', 'tagName'])).tagName;
    gh(['release', 'download', previousTag, '--repo', repository, '--pattern', 'latest.json', '--dir', previousDir]);
    const manifest = updaterManifest({ version, notes: readFileSync(path.join(buildDir, 'RELEASE_NOTES.md'), 'utf8'),
      signature: readFileSync(signature, 'utf8'), archive: path.basename(archive),
      previous: JSON.parse(readFileSync(path.join(previousDir, 'latest.json'), 'utf8')), releaseType });
    writeFileSync(path.join(buildDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (buildGit(['status', '--porcelain', '--untracked-files=no']).trim()) throw new Error('Tracked release source changed during the build.');
    buildGit(['bundle', 'create', 'release/release-source.bundle', 'HEAD', `^${sourceSha}`]);
    const checksums = Object.fromEntries([...files.map(([name]) => name), 'latest.json', 'RELEASE_NOTES.md'].map(name =>
      [name, createHash('sha256').update(readFileSync(path.join(buildDir, name))).digest('hex')]));
    writeFileSync(path.join(buildDir, 'release/build.json'), `${JSON.stringify({ version, releaseType, bump: options.bump, sourceSha, builtSha, checksums }, null, 2)}\n`);
    if (options.mode === '--build-only') {
      console.log(`Local build verified; no release published. Artifacts and build record: ${buildDir}`);
      return;
    }
    publishBuiltRelease({ git, gh, sourceSha, builtSha, version, buildDir, requireLocalPublisher,
      upload: tag => run('bash', ['scripts/publish-release.sh', tag], { cwd: buildDir, env: ghEnv }) });
    console.log(`Published https://github.com/${repository}/releases/tag/v${version}\nBuild record: ${buildDir}/release/build.json`);
  } catch (error) {
    if (buildDir) console.error(`Build worktree retained for diagnosis or upload retry: ${buildDir}`);
    throw error;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(parseArgs(process.argv.slice(2))); } catch (error) {
    console.error(`release-local: ${error.message}`);
    process.exitCode = 1;
  }
}
