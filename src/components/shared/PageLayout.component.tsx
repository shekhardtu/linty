import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { getPageDefinition, type AppView } from "@/config/navigation.config";
import { useAppStore } from "@/store/app.store";
import { useScrollMemory } from "@/hooks/useScrollMemory.hook";
import { BackgroundArtwork } from "@/components/shared/BackgroundArtwork.component";

export function PageLayout({
  children,
  reading = false,
  className,
  ready = true,
}: {
  children: ReactNode;
  reading?: boolean;
  className?: string;
  ready?: boolean;
}) {
  const view = useAppStore((s) => s.currentView);
  const section = useAppStore((s) => s.settingsSection);
  const scroll = useScrollMemory(view === "settings" ? `settings:${section}` : view, ready);
  return (
    <div
      {...scroll}
      className={cn(
        "page-scroll",
        reading ? "preferences-scroll" : "dashboard-scroll",
        className,
      )}
    >
      <div className={cn("page-content", reading && "preferences-content")}>
        {children}
      </div>
    </div>
  );
}

export function PageHeader({
  page,
  title,
  description,
  eyebrow,
  actions,
  editorial = false,
}: {
  page?: AppView;
  title?: string;
  description?: string | null;
  eyebrow?: string;
  actions?: ReactNode;
  editorial?: boolean;
}) {
  const metadata = page ? getPageDefinition(page) : undefined;
  const subtitle =
    description === undefined ? metadata?.description : description;
  return (
    <header className={cn("page-header", editorial && "page-header-editorial")}>
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>
          {title ?? metadata?.title}
          <span className="heading-stop" aria-hidden="true">
            .
          </span>
        </h1>
        {subtitle && <p>{subtitle}</p>}
        <span className="heading-rule" aria-hidden="true" />
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
      <BackgroundArtwork motif={metadata?.artwork ?? "contour"} />
    </header>
  );
}

export function SectionHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {actions}
    </div>
  );
}
