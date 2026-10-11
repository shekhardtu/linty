export const WAVEFORM_BAR_COUNT = 19;
/** Native publishes the level every 6th audio callback (~15/s); poll at that rate. */
export const INPUT_LEVEL_INTERVAL_MS = 65;
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

/** A canvas that also exposes what it last drew, for tests and previews. */
export type LevelCanvas = HTMLCanvasElement & { levels?: number[]; heights?: number[]; strokes?: number[]; span?: [number, number] };

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, r);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, width, height);
  }
}

function fitBackingStore(canvas: HTMLCanvasElement, fallbackWidth: number, fallbackHeight: number) {
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round((canvas.clientWidth || fallbackWidth) * scale));
  const height = Math.max(1, Math.round((canvas.clientHeight || fallbackHeight) * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, scale };
}

/**
 * Draw the waveform bars. Bars are 2 px wide with 2 px gaps, centered; each bar
 * spans 10 % to 100 % of the height and 40 % to 100 % opacity, the same display
 * curve the DOM version used. Drawing on a canvas creates no DOM style writes:
 * WebKit retained memory for every per-frame inline style or custom property
 * write (about 10 MB a minute of recording), while canvas drawing stays flat.
 */
export function drawWaveform(canvas: LevelCanvas, levels: number[], options: { fill?: boolean; idle?: boolean } = {}) {
  const { width, height, scale } = fitBackingStore(canvas, levels.length * 4 - 2, 20);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, width, height);
  const style = getComputedStyle(canvas);
  context.fillStyle = style.color;
  // The gap comes from CSS (`gap` on the canvas), default 2 px.
  const gap = (Number.parseFloat(style.columnGap) || 2) * scale;
  const count = levels.length;
  // `fill` stretches the bars across the full width; otherwise they are 2 px.
  const bar = options.fill ? Math.max(scale, (width - gap * (count - 1)) / count) : 2 * scale;
  const start = options.fill ? 0 : Math.round((width - (count * bar + (count - 1) * gap)) / 2);
  let x = start;
  const heights: number[] = [];
  for (const level of levels) {
    const barHeight = height * (0.1 + level * 0.9);
    heights.push(barHeight / height);
    context.globalAlpha = options.idle ? 0.2 : 0.4 + level * 0.6;
    roundedRect(context, x, (height - barHeight) / 2, bar, barHeight, bar / 2);
    x += bar + gap;
  }
  context.globalAlpha = 1;
  canvas.levels = levels;
  canvas.span = [start / width, (x - gap) / width];
  // What was actually drawn, as a fraction of the canvas height.
  canvas.heights = heights;
}

/** The three strokes of `src-tauri/icons/icon.svg`, in its inner 14 × 16 viewBox. */
const ICON_STROKES: Array<[number, number, number, number]> = [[0, 4, 3, 8], [5.5, 0, 3, 16], [11, 2, 3, 12]];
const ICON_STROKE_RADIUS = 1.5;
const ICON_INNER_ORIGIN = [302 / 1024, 272 / 1024];
const ICON_UNIT = 420 / 14 / 1024;

/**
 * Draw the favicon's three strokes scaled vertically about their centers by
 * `scales` (1 = the resting artwork), over a 22 × 22 CSS px icon.
 */
export function drawBrandStrokes(canvas: LevelCanvas, scales: number[]) {
  const { width, height, scale } = fitBackingStore(canvas, 22, 22);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  const size = Math.min(width, height);
  const unit = ICON_UNIT * size;
  const originX = ICON_INNER_ORIGIN[0] * size;
  const originY = ICON_INNER_ORIGIN[1] * size;
  ICON_STROKES.forEach(([x, y, w, h], index) => {
    const strokeHeight = h * unit * (scales[index] ?? 1);
    const centerY = originY + (y + h / 2) * unit;
    roundedRect(context, originX + x * unit, centerY - strokeHeight / 2, w * unit, strokeHeight, ICON_STROKE_RADIUS * unit);
  });
  canvas.strokes = scales;
  void scale;
}
