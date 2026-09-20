import test from "node:test";
import assert from "node:assert/strict";
import {
  filterByPeriod,
  periodStart,
  summarizeUsage,
  usageByApplication,
  applicationShareSegments,
  usageTimeline,
  formatDuration,
} from "../src/lib/usage.util.ts";

const now = new Date(2026, 8, 12, 14).getTime();
const record = (overrides = {}) => ({
  transcriptId: "test",
  rawText: "",
  finalText: "",
  engine: "local",
  modelName: "Test",
  durationSeconds: 60,
  processingTimeMs: 1500,
  wordCount: 120,
  timestamp: now,
  corrected: false,
  ...overrides,
});

test("7 and 30 day filters include the first local midnight and exclude future entries", () => {
  for (const period of ["7d", "30d"]) {
    const start = periodStart(period, now);
    assert.equal(new Date(start).getHours(), 0);
    const entries = [
      record({ timestamp: start - 1 }),
      record({ timestamp: start }),
      record(),
      record({ timestamp: now + 1 }),
    ];
    assert.deepEqual(filterByPeriod(entries, period, now), entries.slice(1, 3));
  }
});

test("word rate uses total duration instead of averaging per-session rates", () => {
  const stats = summarizeUsage([
    record(),
    record({
      durationSeconds: 180,
      wordCount: 180,
      processingTimeMs: 4500,
      engine: "previous",
    }),
  ]);
  assert.deepEqual(stats, {
    words: 300,
    seconds: 240,
    sessions: 2,
    local: 1,
    avgProcessingSeconds: 3,
    wordsPerMinute: 75,
    localPercent: 50,
  });
  assert.equal(summarizeUsage([]).wordsPerMinute, 0);
  assert.equal(summarizeUsage([]).avgProcessingSeconds, 0);
});

test("app totals use stable bundle IDs, preserve unknown history, and reconcile with overall totals", () => {
  const entries = [
    record({ application: { name: "Editor", bundleId: "app.editor" } }),
    record({ application: { name: "Editor renamed", bundleId: "app.editor" } }),
    record({ application: { name: "Editor", bundleId: "another.editor" } }),
    record(),
    record({ application: null }),
  ];
  const apps = usageByApplication(entries);
  assert.equal(apps.length, 3);
  assert.equal(apps.find((a) => a.id === "bundle:app.editor").words, 240);
  assert.equal(apps.find((a) => !a.attributed).sessions, 2);
  assert.equal(apps.find((a) => a.id === "bundle:app.editor").lastUsedAt, now);
  assert.equal(
    apps.reduce((sum, a) => sum + a.words, 0),
    summarizeUsage(entries).words,
  );
  assert.equal(
    apps.reduce((sum, a) => sum + a.seconds, 0),
    summarizeUsage(entries).seconds,
  );
});

test("timeline responds to period and preserves total words across monthly buckets", () => {
  assert.equal(usageTimeline([], "7d", now).length, 7);
  assert.equal(usageTimeline([], "30d", now).length, 30);
  const entries = [
    record({ timestamp: new Date(2026, 6, 31, 23, 59).getTime() }),
    record({ timestamp: new Date(2026, 7, 1).getTime() }),
    record(),
  ];
  const buckets = usageTimeline(entries, "all", now);
  assert.equal(buckets.length, 3);
  assert.equal(
    buckets.reduce((sum, b) => sum + b.words, 0),
    360,
  );
  assert.deepEqual(
    buckets.map((b) => b.sessions),
    [1, 1, 1],
  );
});

test("calendar buckets stay consecutive over daylight-saving changes", () => {
  const before = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const spring = new Date(2026, 2, 10, 12).getTime();
    const buckets = usageTimeline([], "7d", spring);
    assert.deepEqual(
      buckets.map((b) => new Date(b.timestamp).getDate()),
      [4, 5, 6, 7, 8, 9, 10],
    );
    assert.equal((buckets[5].timestamp - buckets[4].timestamp) / 3600000, 23);
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test("duration labels keep small values and hours honest", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(59.9), "59s");
  assert.equal(formatDuration(3599), "59m 59s");
  assert.equal(formatDuration(3600), "1h 0m");
});


test("app share segments include unattributed words and group the long tail without changing totals", () => {
  const entries = [60,20,10,4,1].map((words,index) => record({ wordCount: words, application: { name: `App ${index}`, bundleId: `app.${index}` } }));
  entries.push(record({wordCount:5}));
  const apps = usageByApplication(entries);
  const segments = applicationShareSegments(apps,100);
  assert.deepEqual(segments.map(s => [s.name,s.words,s.share]), [
    ["App 0",60,60],["App 1",20,20],["App 2",10,10],["Other apps",5,5],["Unattributed",5,5],
  ]);
  assert.equal(segments.reduce((sum,s) => sum+s.share,0),100);
  assert.deepEqual(applicationShareSegments([...apps].reverse(),100),segments,"Distribution ranking is independent of table sort order");
  assert.deepEqual(applicationShareSegments([],0),[]);
  assert.deepEqual(applicationShareSegments(usageByApplication([record({wordCount:5})]),5).map(s=>[s.name,s.share]),[["Unattributed",100]]);
});
