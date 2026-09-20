import { cn } from "@/lib/utils";

interface AppIconProps {
  /** Application name; its first letter is the fallback when no icon resolves. */
  name: string;
  /** PNG data URL from useAppIcons / useAppIcon, or null for the letter fallback. */
  icon?: string | null;
  size?: "sm" | "md";
  className?: string;
  /** Expose an icon-only app identity through its accessible name and native hover tooltip. */
  showNameOnHover?: boolean;
}

/** The app's real macOS icon when available, otherwise a letter avatar (styles: .app-avatar). */
export function AppIcon({
  name,
  icon,
  size = "md",
  className,
  showNameOnHover = false,
}: AppIconProps) {
  return (
    <span
      className={cn(
        "app-avatar",
        size === "sm" && "is-small",
        icon && "has-icon",
        className,
      )}
      aria-hidden={showNameOnHover ? undefined : true}
      role={showNameOnHover ? "img" : undefined}
      aria-label={showNameOnHover ? name : undefined}
      title={showNameOnHover ? name : undefined}
    >
      {icon ? (
        <img src={icon} alt="" draggable={false} />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
