export interface StartupSettings {
  status: "enabled" | "disabled" | "requiresApproval" | "unavailable";
  initialized: boolean;
  error: string | null;
}
