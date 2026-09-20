import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalize, scoreCase, scoreReport } from "../scripts/benchmarks/score-dictation.mjs";

const corpus = JSON.parse(readFileSync(new URL("./fixtures/dictation-challenges.json", import.meta.url)));
const completed = (text, status = "applied") => ({ outcome: "completed", text, metrics: { status } });

test("all reference outputs satisfy their own content constraints", () => {
  assert.equal(new Set(corpus.cases.map((c) => c.id)).size, corpus.cases.length);
  for (const fixture of corpus.cases) {
    assert.ok(fixture.intent);
    for (const text of fixture.expected) {
      assert.equal(scoreCase(fixture, completed(text)).verdict, "reference-match", fixture.id);
    }
  }
});

test("losing a negation or retaining a superseded amount fails even with fluent text", () => {
  const amount = corpus.cases.find((c) => c.id === "07-amount-correction");
  const negative = corpus.cases.find((c) => c.id === "23-preserve-negation");
  assert.equal(scoreCase(amount, completed("Get me 10,000 rupees.")).verdict, "constraint-failure");
  assert.equal(scoreCase(negative, completed("I want to delete the backup.")).verdict, "constraint-failure");
});

test("unlisted paraphrases require review; missing recordings never pass as silence", () => {
  const fixture = corpus.cases[0];
  assert.equal(scoreCase(fixture, completed("Please send me the report.")).verdict, "needs-review");
  assert.equal(scoreCase(fixture, { outcome: "pending-audio" }).verdict, "pending-audio");
  assert.equal(scoreCase(fixture, { outcome: "stt-error", error: "decoder failed", text: "" }).verdict, "runtime-error");
  assert.equal(scoreCase(fixture, { outcome: "no-speech", text: "" }).verdict, "needs-review");
});

test("fallback is an error even when its original text matches the reference", () => {
  const fixture = corpus.cases.find((c) => c.id === "34-short-negative");
  assert.equal(scoreCase(fixture, completed("No.", "fallback")).verdict, "runtime-error");
  assert.equal(scoreCase(fixture, completed("No.", "skipped")).verdict, "runtime-error");
});

test("normalization preserves decimals, signs, and currency", () => {
  assert.notEqual(normalize("1.5"), normalize("15"));
  assert.notEqual(normalize("-5"), normalize("5"));
  assert.notEqual(normalize("₹5"), normalize("$5"));
  assert.equal(normalize("  I’m   here. "), "I'm here.");
});

test("reports cannot silently omit or duplicate cases", () => {
  const report = { schemaVersion: 1, results: corpus.cases.map((fixture) => ({
    id: fixture.id, ...completed(fixture.expected[0]),
  })) };
  assert.equal(scoreReport(corpus, report).counts["reference-match"], corpus.cases.length);
  assert.throws(() => scoreReport(corpus, { ...report, results: report.results.slice(1) }));
  assert.throws(() => scoreReport(corpus, { ...report, results: [report.results[0], ...report.results.slice(0, -1)] }));
});
