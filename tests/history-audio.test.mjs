import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIO_CHUNK_BYTES, MAX_AUDIO_PLAYBACK_BYTES, loadHistoryAudio } from '../src/lib/history-audio.ts';

test('audio reads are sequential, bounded, and preserve every byte', async () => {
  const lengths = [];
  const size = AUDIO_CHUNK_BYTES * 2 + 45;
  const blob = await loadHistoryAudio(size, async (offset, length) => {
    lengths.push([offset, length]);
    return new Uint8Array(length).fill(offset / AUDIO_CHUNK_BYTES + 1).buffer;
  }, new AbortController().signal);
  assert.deepEqual(lengths, [[0, AUDIO_CHUNK_BYTES], [AUDIO_CHUNK_BYTES, AUDIO_CHUNK_BYTES], [AUDIO_CHUNK_BYTES * 2, 45]]);
  assert.equal(blob.size, size);
  assert.equal(blob.type, 'audio/wav');
  const data = new Uint8Array(await blob.arrayBuffer());
  assert.equal(data[0], 1);
  assert.equal(data[AUDIO_CHUNK_BYTES], 2);
  assert.equal(data.at(-1), 3);
});

test('changing selection cancels after the current chunk and releases partial data', async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(loadHistoryAudio(AUDIO_CHUNK_BYTES * 3, async (_, length) => {
    reads++;
    controller.abort();
    return new ArrayBuffer(length);
  }, controller.signal), { name: 'AbortError' });
  assert.equal(reads, 1);
});

test('large, invalid and incomplete recordings cannot trigger oversized playback allocations', async () => {
  for (const bytes of [0, NaN, 43, MAX_AUDIO_PLAYBACK_BYTES + 1]) {
    await assert.rejects(loadHistoryAudio(bytes, async () => { assert.fail('Must not fetch'); }, new AbortController().signal));
  }
  await assert.rejects(loadHistoryAudio(100, async () => new ArrayBuffer(50), new AbortController().signal), /incomplete/);
});
