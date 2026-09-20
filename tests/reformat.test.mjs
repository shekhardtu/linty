import test from "node:test";
import assert from "node:assert/strict";
import { initialReformatMetrics, reformatOptions, reformatApplied, supportsLocalCleanup } from "../src/lib/reformat.util.ts";

test("local cleanup requires an explicit English selection", () => {
  assert.equal(supportsLocalCleanup("en"), true);
  for (const language of ["auto", "hi", "es", "fr", "ar", "zh", "", "unknown"]) {
    assert.equal(supportsLocalCleanup(language), false, language);
  }
});

test("context uses known mail apps only, with explicit overrides and privacy fallback", () => {
  assert.equal(reformatOptions("semi-formal", true, "auto", "com.apple.mail").context, "email");
  assert.equal(reformatOptions("semi-formal", true, "auto", "com.google.Chrome").context, "general");
  assert.equal(reformatOptions("semi-formal", true, "auto", null).context, "general");
  assert.equal(reformatOptions("formal", false, "general", "com.apple.mail").context, "general");
  assert.deepEqual(reformatOptions("formal", false, "email", null), { styling: "formal", structure: "prose", context: "email" });
});

test("off and failed attempts preserve counts without inventing measured throughput", () => {
  const options = reformatOptions("semi-formal", true, "auto");
  const off = initialReformatMetrics("Hello 👋", false, "auto", options);
  assert.equal(off.status, "disabled");
  assert.equal(off.inputCharacters, 7);
  assert.equal(off.outputWords, 2);
  assert.equal(off.tokensPerSecond, undefined);
  assert.equal(off.totalMs, 0);
  const attempt = initialReformatMetrics("Keep the original.", true, "en", options);
  assert.equal(attempt.status, "fallback");
  assert.equal(attempt.changed, false);
  assert.equal(attempt.totalMs, undefined);
  assert.equal(reformatApplied(attempt), false);
  assert.equal(reformatApplied({ status: "skipped" }), false);
  assert.equal(reformatApplied({ status: "applied" }), true);
  assert.equal(reformatApplied({ status: "unchanged" }), true);
});
