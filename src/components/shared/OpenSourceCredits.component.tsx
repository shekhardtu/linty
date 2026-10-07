import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";
import { useAppStore } from "@/store/app.store";
import "./open-source-credits.css";

const projects = [
  { name: "Whisper by OpenAI", url: "https://github.com/openai/whisper", contribution: "Speech recognition models." },
  { name: "whisper.cpp", url: "https://github.com/ggml-org/whisper.cpp", contribution: "Local speech inference by the ggml authors and contributors." },
  { name: "whisper-rs", url: "https://codeberg.org/tazz4843/whisper-rs", contribution: "Rust bindings for whisper.cpp." },
  { name: "Parakeet by NVIDIA", url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3", contribution: "Speech recognition and vocabulary models." },
  { name: "Parakeet Ultra by moondream", url: "https://huggingface.co/moondream/parakeet-ultra", contribution: "Improved Parakeet speech model, converted to Core ML by FluidInference." },
  { name: "FluidAudio by FluidInference", url: "https://github.com/FluidInference/FluidAudio", contribution: "Apple speech inference and Core ML model conversions." },
  { name: "S1-mini by Superwhisper", url: "https://huggingface.co/superwhisper/s1-mini-GGUF", contribution: "Optional on-device text cleanup." },
  { name: "Qwen by Alibaba Cloud", url: "https://huggingface.co/Qwen/Qwen3-0.6B", contribution: "The base model from which S1-mini is derived." },
  { name: "Candle by Hugging Face", url: "https://github.com/huggingface/candle", contribution: "Local text-cleanup inference in Rust." },
  { name: "Tauri", url: "https://github.com/tauri-apps/tauri", contribution: "The desktop application framework." },
  { name: "React", url: "https://github.com/facebook/react", contribution: "The application interface." },
  { name: "Lucide", url: "https://github.com/lucide-icons/lucide", contribution: "Interface icons." },
];

// Load original bundled documents on demand, without contacting an external site.
const documents = {
  software: { label: "Software licenses and notices", load: () => import("../../../src-tauri/licenses/THIRD_PARTY_NOTICES.txt?raw") },
  models: { label: "Model attribution", load: () => import("../../../src-tauri/licenses/MODELS.md?raw") },
  s1License: { label: "S1-mini license", load: () => import("../../../src-tauri/licenses/s1-mini/LICENSE?raw") },
  s1Notice: { label: "S1-mini notice", load: () => import("../../../src-tauri/licenses/s1-mini/NOTICE?raw") },
};
type DocumentKey = keyof typeof documents;

export function OpenSourceCredits() {
  const [isOpen, setIsOpen] = useState(false);
  const [selected, setSelected] = useState<DocumentKey | "credits">("credits");
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!isOpen || !dialog.current) return;
    const element = dialog.current;
    element.showModal();
    close.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      opener.current?.focus({ preventScroll: true });
    };
  }, [isOpen]);

  useEffect(() => {
    if (reader.current) reader.current.scrollTop = 0;
    if (!isOpen || selected === "credits") return;
    let active = true;
    setText(null);
    setFailed(false);
    void documents[selected].load().then(module => {
      if (active) setText(module.default);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [isOpen, selected, attempt]);

  const visit = (url: string) => {
    void open(url).catch(() => useAppStore.getState().addToast({
      type: "error", message: "Could not open the project website. Please try again.",
    }));
  };

  return <section className="about-credits" aria-labelledby={`${id}-summary`}>
    <div>
      <h2 id={`${id}-summary`}>Built with open source</h2>
      <p>Thank you to the people behind our speech models, local engines, and interface.</p>
    </div>
    <button ref={opener} className="text-link" onClick={() => { setSelected("credits"); setIsOpen(true); }}>
      Credits and licenses
    </button>
    <dialog ref={dialog} className="confirmation-dialog credits-dialog" aria-labelledby={`${id}-title`}
      onCancel={event => { event.preventDefault(); setIsOpen(false); }}>
      {isOpen && <>
        <div className="credits-heading">
          <div><h2 id={`${id}-title`}>Credits and licenses</h2><p>Included with this version of Linty · Available offline</p></div>
          <button ref={close} className="standard-button" onClick={() => setIsOpen(false)}>Close</button>
        </div>
        <div className="credits-document-picker">
          <label htmlFor={`${id}-document`}>View</label>
          <select id={`${id}-document`} value={selected} onChange={event => setSelected(event.target.value as DocumentKey | "credits")}>
            <option value="credits">Acknowledgments</option>
            {Object.entries(documents).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
          </select>
        </div>
        <div ref={reader} className="credits-reader" tabIndex={0} role="region"
          aria-label={selected === "credits" ? "Acknowledgments" : documents[selected].label}>
          {selected === "credits" ? <>
            <p>Linty is made possible by these projects and the many maintainers behind our dependencies. Thank you for sharing your work.</p>
            <ul className="credits-projects">
              {projects.map(project => <li key={project.name}>
                <button className="text-link" onClick={() => visit(project.url)}>
                  {project.name} <ArrowUpRight size={12} aria-hidden="true" />
                </button>
                <p>{project.contribution}</p>
              </li>)}
            </ul>
            <p>Each component and model retains its own license. Choose a document above to read the full bundled notices. Project links open in your browser.</p>
          </> : failed ? <div role="alert">
            <p>Could not load this bundled document.</p>
            <button className="standard-button" onClick={() => setAttempt(value => value + 1)}>Retry</button>
          </div> : text === null ? <p role="status">Loading document…</p> : <pre>{text}</pre>}
        </div>
      </>}
    </dialog>
  </section>;
}
