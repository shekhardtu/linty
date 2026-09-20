import type { ThemePreference } from "@/store/slices/settings.slice";

export function ThemePreview({ theme }: { theme: ThemePreference }) {
  return (
    <span className={`theme-preview theme-preview-${theme}`} aria-hidden="true">
      <i />
      <span>
        <b />
        <i />
        <i />
        <em />
      </span>
    </span>
  );
}
