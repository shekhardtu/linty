import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Only harmless typography/whitespace differences are ignored. Do not erase
// negation, currency, decimal separators, words, or number signs to get a match.
export const normalize = (text) => text.normalize("NFC")
  .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

export function scoreCase(fixture, result) {
  if (result.outcome === "pending-audio") return { verdict: "pending-audio", violations: [] };
  const noSpeech = result.outcome === "no-speech" && result.text === "";
  if (!noSpeech && (result.outcome !== "completed"
    || !["applied", "unchanged"].includes(result.metrics?.status))) {
    return { verdict: "runtime-error", violations: [result.error ?? result.metrics?.reason ?? result.outcome] };
  }
  if (typeof result.text !== "string") throw new Error(`Missing output for ${fixture.id}`);
  const text = normalize(result.text);
  const violations = [
    ...(fixture.required ?? []).filter((pattern) => !new RegExp(pattern, "iu").test(text))
      .map((pattern) => `Missing required content: ${pattern}`),
    ...(fixture.forbidden ?? []).filter((pattern) => new RegExp(pattern, "iu").test(text))
      .map((pattern) => `Retained forbidden content: ${pattern}`),
  ];
  if (violations.length) return { verdict: "constraint-failure", violations };
  return {
    verdict: fixture.expected.some((expected) => normalize(expected) === text) ? "reference-match" : "needs-review",
    violations,
  };
}

export function scoreReport(corpus, report) {
  if (corpus.schemaVersion !== 1 || report.schemaVersion !== 1) throw new Error("Unsupported schema");
  const fixtures = new Map(corpus.cases.map((fixture) => [fixture.id, fixture]));
  const results = new Map(report.results.map((result) => [result.id, result]));
  if (fixtures.size !== corpus.cases.length || results.size !== report.results.length
    || fixtures.size !== results.size || [...results.keys()].some((id) => !fixtures.has(id))) {
    throw new Error("Corpus and report must have exactly the same unique case IDs");
  }
  const counts = {};
  const byCategory = {};
  const scored = corpus.cases.map((fixture) => {
    const result = results.get(fixture.id);
    const assessment = scoreCase(fixture, result);
    counts[assessment.verdict] = (counts[assessment.verdict] ?? 0) + 1;
    const category = byCategory[fixture.category] ??= {};
    category[assessment.verdict] = (category[assessment.verdict] ?? 0) + 1;
    return { ...result, category: fixture.category, referenceInput: fixture.input,
      expected: fixture.expected, intent: fixture.intent, ...assessment };
  });
  return { ...report, scoringVersion: 1,
    scoringNote: "Reference matches and lexical checks are screening signals, not proof of semantic accuracy. Review all outputs for meaning; unmatched paraphrases may be valid. Text runs do not measure speech recognition or acoustic noise handling.",
    counts, byCategory, results: scored };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [corpusPath, reportPath, outputPath] = process.argv.slice(2);
  if (!corpusPath || !reportPath || !outputPath) {
    throw new Error("usage: node scripts/benchmarks/score-dictation.mjs CORPUS.json REPORT.json SCORED.json");
  }
  const bytes = readFileSync(corpusPath);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (createHash("sha256").update(bytes).digest("hex") !== report.corpusSha256) {
    throw new Error("Corpus changed since evaluation; rerun before scoring");
  }
  const scored = scoreReport(JSON.parse(bytes.toString("utf8")), report);
  writeFileSync(outputPath, `${JSON.stringify(scored, null, 2)}\n`);
  console.log(JSON.stringify({ source: scored.source, counts: scored.counts, byCategory: scored.byCategory }, null, 2));
}
