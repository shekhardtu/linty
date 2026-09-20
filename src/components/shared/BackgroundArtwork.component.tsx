import { SoundPattern } from "@/components/shared/BrandMark.component";
import { cn } from "@/lib/utils";
import artwork from "@/assets/brand-artwork.json";

export type BackgroundMotif = "flow" | "contour";

/** Decorative voice contours: shared geometry, theme colors, no interactive surface. */
export function BackgroundArtwork({
  motif = "flow",
  className,
}: {
  motif?: BackgroundMotif;
  className?: string;
}) {
  return (
    <span
      className={cn("background-artwork", `background-artwork-${motif}`, className)}
      aria-hidden="true"
    >
      {motif === "contour" ? (
        <SoundPattern />
      ) : (
        <svg viewBox={artwork.flow.viewBox} preserveAspectRatio="none" fill="none" focusable="false">
          {artwork.flow.paths.map((path, i) => (
            <path
              key={i}
              d={path}
              stroke="currentColor"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      )}
    </span>
  );
}
