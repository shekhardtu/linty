export const WAVEFORM_BAR_COUNT = 19;
export const flatWaveform = () => Array<number>(WAVEFORM_BAR_COUNT).fill(0);

/** Visual response only: never changes capture gain or inactivity detection. */
export function advanceWaveform(previous: number[], rms: number): number[] {
  // Reserve the short display's travel for speech and emphasis. Squaring the
  // log level holds room noise near the baseline; the ceiling leaves headroom.
  const normalized = Number.isFinite(rms) && rms > 0
    ? Math.max(0, Math.min(1, (20 * Math.log10(rms) + 72) / 66)) : 0;
  const target = normalized * normalized * 0.9;
  const last = previous[previous.length - 1] ?? 0;
  const smoothed = last + (target - last) * (target > last ? 0.55 : 0.28);
  return [...previous.slice(1), smoothed < 0.004 ? 0 : smoothed];
}
