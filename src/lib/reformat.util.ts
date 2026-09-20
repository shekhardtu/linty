import type { ReformatContext, ReformatMetrics, ReformatOptions, ReformatStyle } from "../types/reformat.types.ts";

/** Auto-detect still requires confidently English text in the native engine. */
export function supportsLocalCleanup(language: string): boolean {
  return language === "en" || language === "auto";
}

export function reformatOptions(style: ReformatStyle, lists: boolean, context: ReformatContext, bundleId?: string | null): ReformatOptions {
  const mailApp = ["com.apple.mail", "com.microsoft.Outlook", "com.readdle.smartemail-Mac"].includes(bundleId ?? "");
  return { styling: style, structure: lists ? "lists" : "prose", context: context === "email" || (context === "auto" && mailApp) ? "email" : "general" };
}

export function initialReformatMetrics(text: string, enabled: boolean, language: string, options: ReformatOptions): ReformatMetrics {
  const words = text.split(/\s+/).filter(Boolean).length;
  return {
    schemaVersion: 1, enabled, status: enabled ? "fallback" : "disabled",
    options, requestedLanguage: language, ...(enabled ? {} : { totalMs: 0 }),
    inputWords: words, outputWords: words,
    inputCharacters: [...text].length, outputCharacters: [...text].length, changed: false,
  };
}

export const reformatApplied = (metrics: Pick<ReformatMetrics, "status">) =>
  metrics.status === "applied" || metrics.status === "unchanged";

export function reformatStatusLabel(metrics: ReformatMetrics): string {
  switch (metrics.status) {
    case "disabled": return "Off";
    case "applied": return "Reformatted";
    case "unchanged": return "No changes needed";
    case "fallback": return "Original kept — reformatting failed";
    case "skipped": return "Original kept — reformatting skipped";
  }
}
