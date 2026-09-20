export interface CorrectionFeedback {
  title: string;
  message: string;
  learned: boolean;
  actions?: CorrectionFeedbackAction[];
}

export interface CorrectionFeedbackAction {
  label: string;
  action: "review" | "undo";
  id?: string;
}

/** Only acknowledge dictionary changes after they have been saved. */
export function correctionFeedback(
  result: { learned: number; suggested: number; pending?: number },
  dictionaryEnabled: boolean,
): CorrectionFeedback | null {
  if (result.learned) return {
    title: result.learned === 1 ? "Correction learned" : `${result.learned} corrections learned`,
    message: dictionaryEnabled
      ? result.learned === 1 ? "I’ll remember it next time." : "I’ll remember them next time."
      : "Saved. Turn on Dictionary to use it.",
    learned: true,
  };
  if (result.suggested) return {
    title: "Correction noted",
    message: "Review it in Dictionary to use it next time.",
    learned: false,
  };
  if (result.pending) return {
    title: "Correction noted",
    message: "I’ll keep learning from your edits.",
    learned: false,
  };
  return null;
}
