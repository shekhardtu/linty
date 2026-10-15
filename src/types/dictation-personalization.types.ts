import type { ReformatStyle } from "./reformat.types";

export interface VoiceSnippet { id: string; phrase: string; text: string }
export interface AppStyleProfile { bundleId: string; style: ReformatStyle }
