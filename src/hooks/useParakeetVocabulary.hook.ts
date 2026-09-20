import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/app.store";

const PARAKEET_ID = "parakeet-tdt-0.6b-v3";

/**
 * Parakeet has no vocabulary prompt; it recognises dictionary words through a
 * small CTC keyword-spotter model. Fetch and load it the first time the
 * dictionary has words while Parakeet is the running engine. Later engine
 * loads pick the models up from disk on the Rust side.
 */
export function useParakeetVocabulary() {
  const loadedModelFilename = useAppStore((s) => s.loadedModelFilename);
  const dictionaryEnabled = useAppStore((s) => s.dictionaryEnabled);
  const hasWords = useAppStore((s) => s.dictionaryEntries.some((e) => e.enabled));
  const status = useAppStore((s) => s.parakeetVocabularyStatus);
  const setStatus = useAppStore((s) => s.setParakeetVocabularyStatus);
  // One attempt per combination of engine and dictionary state: a failed download is
  // retried the next time any of those change, never in a loop on the error itself.
  const attemptedKey = useRef<string | null>(null);

  useEffect(() => {
    const wanted = loadedModelFilename === PARAKEET_ID && dictionaryEnabled && hasWords;
    const key = `${loadedModelFilename}|${dictionaryEnabled}|${hasWords}`;
    if (!wanted || status === "preparing" || attemptedKey.current === key) return;
    attemptedKey.current = key;
    setStatus("preparing");
    invoke<boolean>("prepare_parakeet_vocabulary")
      .then((downloaded) => {
        setStatus("ready");
        if (downloaded) {
          useAppStore.getState().addToast({ type: "success", message: "Parakeet can now recognise the words in your dictionary." });
        }
      })
      .catch((error) => {
        console.error("Failed to prepare Parakeet vocabulary:", error);
        setStatus("error");
        useAppStore.getState().addToast({
          type: "warning",
          message: "Could not prepare Parakeet’s vocabulary model. Dictionary words are still fixed after transcription.",
        });
      });
  }, [loadedModelFilename, dictionaryEnabled, hasWords, status, setStatus]);
}
