export type ReformatStyle = "casual" | "semi-casual" | "semi-formal" | "formal";
export type ReformatContext = "auto" | "general" | "email";
export type CleanupMode = "off" | "local";
export interface ReformatOptions {
  styling: ReformatStyle;
  structure: "prose" | "lists";
  context: "general" | "email";
}

/** Optional fields distinguish unmeasured values from measured zeroes. */
export interface ReformatMetrics {
  schemaVersion: 1;
  enabled: boolean;
  status: "disabled" | "applied" | "unchanged" | "skipped" | "fallback";
  reason?: string | null;
  options: ReformatOptions;
  requestedLanguage: string;
  detectedLanguage?: string | null;
  languageConfidence?: number | null;
  totalMs?: number;
  /** Includes IPC and waiting for a resident model; native totalMs does not. */
  roundTripMs?: number;
  modelId?: string;
  modelRevision?: string;
  tokenizerRevision?: string;
  quantization?: string;
  promptVersion?: number;
  runtime?: string;
  backend?: string;
  appVersion?: string;
  architecture?: string;
  hardware?: { chip: string | null; memoryBytes: number | null; osVersion: string | null; logicalCpus: number };
  modelBytes?: number;
  modelLoadMs?: number;
  prefillMs?: number;
  decodeMs?: number;
  firstTokenMs?: number | null;
  inputTokens?: number;
  promptTokens?: number;
  generatedTokens?: number;
  decodeTokens?: number;
  tokensPerSecond?: number | null;
  chunks?: number;
  completedChunks?: number;
  inputWords: number;
  outputWords: number;
  inputCharacters: number;
  outputCharacters: number;
  changed: boolean;
}
export interface ReformatResult {
  text: string;
  metrics: ReformatMetrics;
}
