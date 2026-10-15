import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAppStyles, normalizeSnippets, snippetPhrase } from "../src/lib/dictation-personalization.util.ts";

test("snippet validation rejects ambiguity and preserves deliberate multiline text", () => {
  const entry = { id: "1", phrase: "My Signature", text: "Thanks,\nHari\n" };
  assert.deepEqual(normalizeSnippets([entry]), [entry]);
  assert.equal(snippetPhrase(" My Signature. "), "my signature");
  assert.deepEqual(normalizeSnippets([entry, { ...entry, id: "2", phrase: "my signature!" }]), [entry]);
  for (const value of [null, {}, [null], [{ ...entry, text: " " }], [{ ...entry, text: "x\0y" }], [{ ...entry, text: "a".repeat(10001) }]]) {
    assert.deepEqual(normalizeSnippets(value), []);
  }
});
test("app profiles accept exact native IDs and only supported writing styles", () => {
  const profile = { bundleId: "com.apple.mail", style: "formal" };
  assert.deepEqual(normalizeAppStyles([profile, profile]), [profile]);
  assert.deepEqual(normalizeAppStyles([{ ...profile, bundleId: "https://mail.example" }, { ...profile, style: "invented" }]), []);
  assert.deepEqual(normalizeAppStyles(undefined), []);
});
