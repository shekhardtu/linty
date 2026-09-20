import { cn } from "@/lib/utils";
import artwork from "@/assets/brand-artwork.json";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("brand-mark", className)} aria-hidden="true" />
  );
}

/** A complete, scalable voice motif shared by navigation and setup. */
export function SoundPattern({ className }: { className?: string }) {
  return (
    <svg
      className={cn("sound-pattern", className)}
      viewBox={artwork.contour.viewBox}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g transform={artwork.contour.transform}>
        {artwork.contour.ellipses.map((ellipse, i) => (
          <ellipse
            key={i}
            {...ellipse}
            stroke="currentColor"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
    </svg>
  );
}
