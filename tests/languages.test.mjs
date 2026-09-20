import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_LANGUAGE, TRANSCRIPTION_LANGUAGES, PARAKEET_LANGUAGES, PARAKEET_MODEL, WHISPER_MODEL, isSupportedLanguage, languageLabel, nativeLanguageLabel, modelForLanguage, modelSupportsLanguage } from "../src/lib/languages.util.ts";

const catalog = [{ filename: PARAKEET_MODEL }, { filename: WHISPER_MODEL }];
test("every selectable language has compatible speech support", () => {
  const codes = TRANSCRIPTION_LANGUAGES.map(({ code }) => code);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(codes.length, 101);
  for (const code of codes) {
    assert.ok(modelForLanguage(code, catalog), code);
    assert.equal(modelForLanguage(code, [catalog[1]]), catalog[1], `Whisper-only build: ${code}`);
    assert.ok(nativeLanguageLabel(code));
  }
});
test("Parakeet serves its supported languages; Whisper serves broader choices and auto-detect", () => {
  assert.equal(PARAKEET_LANGUAGES.size, 25);
  for (const code of PARAKEET_LANGUAGES) assert.equal(modelForLanguage(code, catalog), catalog[0]);
  for (const code of [AUTO_LANGUAGE, "hi", "ta", "te", "ja", "zh", "ko", "ar", "yue"]) {
    assert.equal(isSupportedLanguage(code), true);
    assert.equal(modelForLanguage(code, catalog), catalog[1]);
    assert.equal(modelForLanguage(code, [catalog[0]]), undefined, "Never fall back to an incompatible model");
  }
  assert.equal(modelForLanguage("xx", catalog), undefined);
  assert.equal(modelForLanguage("en", []), undefined);
});
test("auto-detect and English stay easy to find and labels support native search", () => {
  assert.equal(TRANSCRIPTION_LANGUAGES[0].code, AUTO_LANGUAGE);
  assert.equal(TRANSCRIPTION_LANGUAGES[1].code, "en");
  assert.equal(languageLabel("de"), "German");
  assert.equal(languageLabel("xx"), "xx");
  assert.equal(isSupportedLanguage("xx"), false);
  assert.equal(isSupportedLanguage(null), false);
  assert.match(nativeLanguageLabel("hi"), /हिन्दी|हिंदी/);
});

test("a stale local model cannot serve an incompatible language during preparation", () => {
  assert.equal(modelSupportsLanguage(PARAKEET_MODEL, "hi"), false);
  assert.equal(modelSupportsLanguage(PARAKEET_MODEL, "auto"), false);
  assert.equal(modelSupportsLanguage(PARAKEET_MODEL, "fr"), true);
  assert.equal(modelSupportsLanguage(WHISPER_MODEL, "hi"), true);
  assert.equal(modelSupportsLanguage(null, "en"), false);
});
