import { useEffect, useId, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import legal from "@/content/legal.json";
import { useAppStore } from "@/store/app.store";
import "./legal-notice.css";

/** Bundled text: reading either notice makes no network request. */
export function LegalNotice({ compact = false }: { compact?: boolean }) {
  const [selected, setSelected] = useState<"privacy" | "terms" | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const document = selected ? legal[selected] : null;
  useEffect(() => {
    if (!selected || !dialog.current) return;
    const element = dialog.current;
    const previous = opener.current ?? window.document.activeElement as HTMLElement | null;
    element.showModal();
    element.scrollTop = 0;
    close.current?.focus({ preventScroll: true });
    return () => { element.close(); previous?.focus({ preventScroll: true }); };
  }, [selected]);
  const follow = (url: string) => {
    void open(url).catch(() => useAppStore.getState().addToast({ type: "error", message: "Could not open the link. Please try again." }));
  };
  return <div className="legal-notice">
    <div className="legal-notice-links">
      <button type="button" className="text-link" aria-label="Privacy notice" onClick={(event) => { opener.current = event.currentTarget; setSelected("privacy"); }}>{compact ? "Privacy" : "Privacy notice"}</button>
      <button type="button" className="text-link" onClick={(event) => { opener.current = event.currentTarget; setSelected("terms"); }}>{compact ? "License & terms" : "License and responsible use"}</button>
    </div>
    <dialog ref={dialog} className="confirmation-dialog legal-notice-dialog" aria-labelledby={`${id}-title`}
      onCancel={(event) => { event.preventDefault(); setSelected(null); }}>
      {document && <>
        <div className="legal-notice-heading"><h2 id={`${id}-title`}>{document.title}</h2>
          <button ref={close} type="button" className="standard-button" onClick={() => setSelected(null)}>Close</button></div>
        <p>Updated {legal.updated} · Available offline</p>
        <p>{document.intro}</p>
        {document.sections.map(section => <section key={section.id} aria-labelledby={`${id}-${section.id}`}>
          <h3 id={`${id}-${section.id}`}>{section.title}</h3>
          {section.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
          {"links" in section && section.links?.map(link => <p key={link.url}>
            <button type="button" className="text-link" onClick={() => follow(link.url)}>{link.label} ↗</button>
          </p>)}
        </section>)}
      </>}
    </dialog>
  </div>;
}
