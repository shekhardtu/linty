import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsSaveFeedback, createSettingsWriter } from "../src/lib/settings-save-feedback.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("a failed older write cannot roll back a newer saved preference", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const feedback = createSettingsSaveFeedback();
  const save = createSettingsWriter(feedback);
  const disk = deferred();
  let stored = "light";
  const first = save("theme", async () => {
    stored = "dark";
    try { await disk.promise; }
    catch (error) { stored = "light"; throw error; }
  });
  const rejected = assert.rejects(first, /Disk full/);
  const second = save("theme", async () => { stored = "system"; });
  disk.reject(new Error("Disk full"));
  await rejected;
  await second;
  assert.equal(stored, "system");
  t.mock.timers.tick(300);
  assert.equal(feedback.getSnapshot(), "saved");
  t.mock.timers.tick(2500);
});

test("save feedback waits for persistence and keeps a brief confirmation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const feedback = createSettingsSaveFeedback();
  const disk = deferred();
  assert.equal(feedback.getSnapshot(), "idle");
  const saving = feedback.run("theme", () => disk.promise);
  t.mock.timers.tick(1000);
  assert.equal(feedback.getSnapshot(), "saving");
  disk.resolve();
  await saving;
  t.mock.timers.tick(300);
  assert.equal(feedback.getSnapshot(), "saved");
  t.mock.timers.tick(2500);
  assert.equal(feedback.getSnapshot(), "idle");
});

test("overlapping saves and old confirmation timers never signal success early", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const feedback = createSettingsSaveFeedback();
  const disk = deferred();
  await feedback.run("theme", async () => {});
  t.mock.timers.tick(100);
  const saving = feedback.run("language", () => disk.promise);
  await feedback.run("layout", async () => {});
  t.mock.timers.tick(5000);
  assert.equal(feedback.getSnapshot(), "saving");
  disk.resolve();
  await saving;
  t.mock.timers.tick(300);
  assert.equal(feedback.getSnapshot(), "saved");
  const nextDisk = deferred();
  const nextSave = feedback.run("theme", () => nextDisk.promise);
  t.mock.timers.tick(5000);
  assert.equal(feedback.getSnapshot(), "saving");
  nextDisk.resolve();
  await nextSave;
  t.mock.timers.tick(2800);
});

test("failed writes stay visible across unrelated saves and recover on retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const feedback = createSettingsSaveFeedback();
  await assert.rejects(feedback.run("theme", async () => { throw new Error("Disk full"); }), /Disk full/);
  assert.equal(feedback.getSnapshot(), "error");
  await feedback.run("language", async () => {});
  t.mock.timers.tick(5000);
  assert.equal(feedback.getSnapshot(), "error");
  await feedback.run("theme", async () => {});
  t.mock.timers.tick(300);
  assert.equal(feedback.getSnapshot(), "saved");
  t.mock.timers.tick(2500);
});
