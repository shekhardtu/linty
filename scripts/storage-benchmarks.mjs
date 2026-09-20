import { readFile } from 'node:fs/promises';

// Display the checked-in measurements; this command never runs the benchmark
// or opens the user's history archive.
const report = JSON.parse(await readFile(
  new URL('../docs/benchmarks/audio-history-storage-2026-09-19.json', import.meta.url),
  'utf8',
));
const ms = (value) => `${value.toFixed(1)} ms`;
const mb = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const row = (label, values) => `${label.padEnd(36)}${values.map(value => value.padStart(22)).join('')}`;
const wrap = (text) => text.replace(/(.{1,78})(?:\s+|$)/g, '$1\n').trimEnd();
const measurements = [
  ['Save elapsed time', result => ms(result.saveWallMs)],
  ['Save CPU time', result => ms(result.saveCpuMs)],
  ['Additional peak memory during save', result => mb(result.peakRssAfterSaveBytes - result.peakRssBeforeSaveBytes)],
  ['Existing capture buffer', result => mb(result.sharedCaptureBytes)],
  ['Saved WAV size', result => mb(result.savedWavBytes)],
  ['Read all audio chunks', result => ms(result.readAllChunksMs)],
  ['Export WAV', result => ms(result.exportWallMs)],
  ['Delete recording', result => ms(result.deleteWallMs)],
];

console.log([
  'Storage — saved dictation audio benchmark',
  '',
  `Measured: ${report.date} · ${report.machine.chip} · ${report.machine.memoryBytes / 2 ** 30} GiB RAM · macOS ${report.machine.macOS}`,
  'Recorded results, not a benchmark of this machine.',
  '',
  row('Measurement', report.results.map(result => `${result.audioSeconds / 60}-minute recording`)),
  '-'.repeat(36 + 22 * report.results.length),
  ...measurements.map(([label, format]) => row(label, report.results.map(format))),
  '',
  'Memory: the increase above the existing capture buffer, not total app memory.',
  'MB uses decimal units. CPU time is accumulated processor time, not CPU usage %.',
  '',
  'Saving adds no GPU or Neural Engine inference; speech-model costs are unchanged.',
  'Saved WAV audio uses about 1.92 MB/min; the shared capture buffer uses 3.84 MB/min.',
  'Encoding uses 32 KiB scratch space; native reads are limited to 1 MiB per chunk.',
  'Playback loads on request, up to 64 MiB; larger recordings can be exported.',
  'Finite retention deletes expired recordings. Deleted database space is reused;',
  'the archive file does not automatically shrink.',
  '',
  wrap(`Method: ${report.method}`),
  'Storage only: excludes speech inference and playback; not a system-wide',
  'GPU/Neural Engine measurement or a latency guarantee.',
  '',
  'Source: docs/benchmarks/audio-history-storage-2026-09-19.json',
  'Details: docs/HISTORY-STORAGE.md#storage-benchmark',
  '',
  'To run a new synthetic benchmark (temporary archive, removed afterward):',
  '  cargo run --manifest-path src-tauri/Cargo.toml --release --example audio_history_bench -- 1800',
  'Use 60 instead of 1800 for one minute.',
].join('\n'));
