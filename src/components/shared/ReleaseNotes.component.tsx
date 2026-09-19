import notes from "../../../RELEASE_NOTES.md?raw";
import { version as bundledVersion } from "../../../package.json";
import { isVersion, normalizeVersion } from "@/lib/force-update.util";
import { releaseHighlights } from "@/lib/update-acknowledgment";

export function installedReleaseNotes(version: string | null) {
  return version && normalizeVersion(version) === bundledVersion ? notes : null;
}

export function releaseUrl(version: string) {
  return isVersion(version)
    ? `https://github.com/shekhardtu/linty/releases/tag/v${encodeURIComponent(normalizeVersion(version))}`
    : "https://github.com/shekhardtu/linty/releases";
}

/** Release text is rendered as text, never injected HTML or executable links. */
export function ReleaseNotes({ notes }: { notes: string | null }) {
  const highlights = releaseHighlights(notes);
  return highlights.length ? (
    <ul className="release-highlights">
      {highlights.map((highlight, index) => <li key={index}>{highlight}</li>)}
    </ul>
  ) : <p>Read the release notes for details about this version.</p>;
}
