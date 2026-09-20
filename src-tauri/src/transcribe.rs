use std::sync::OnceLock;
use std::time::Duration;

#[cfg(test)]
#[path = "transcribe_tests.rs"]
mod tests;

/// Shared HTTP client for model downloads (longer timeout).
fn download_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(600))
            .build()
            .expect("Failed to build HTTP client")
    })
}

// ── Audio and decoder evidence ──

/// Only short-circuit effectively digital silence (the same 1e-10 floor used
/// by FluidAudio's VAD). This is NOT a speech detector: noise can pass it.
/// A volume threshold or active-window ratio can discard quiet speech and
/// short answers surrounded by pauses, before the model gets to hear them.
pub(crate) fn audio_has_signal(samples: &[f32]) -> bool {
    samples.iter().any(|s| s.is_finite() && s.abs() > 1e-10)
}

// whisper.cpp's paired defaults. Neither a phrase nor low confidence alone
// proves silence. These thresholds do not apply to Parakeet's token confidence.
const WHISPER_NO_SPEECH_THRESHOLD: f32 = 0.6;
const WHISPER_LOGPROB_THRESHOLD: f32 = -1.0;

/// Repetition is diagnostic only; intentional emphasis and stutters are valid.
fn has_repeated_word(text: &str) -> bool {
    let normalized = text.to_lowercase();
    let mut words = normalized
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|w| !w.is_empty());
    let Some(first) = words.next() else {
        return false;
    };
    let mut count = 1;
    for word in words {
        if word != first {
            return false;
        }
        count += 1;
    }
    count >= 3
}

/// Never reject a transcript based on its words, byte length, or repetition.
fn finish_transcript(text: &str, engine: &str) -> String {
    let text = text.trim();
    if has_repeated_word(text) {
        log::info!("[transcribe] {engine}: repeated words retained; repetition alone is not evidence of silence");
    }
    text.to_string()
}

// ── Local STT via whisper-rs ──

/// Run whisper.cpp over `samples`. `on_partial` receives the accumulated text
/// as each segment decodes; `on_progress` receives 0–100. Both may fire from
/// whisper's worker thread.
#[cfg(feature = "local-stt")]
pub fn transcribe_local<P, G>(
    ctx: &whisper_rs::WhisperContext,
    samples: &[f32],
    prompt: Option<&str>,
    language: Option<&str>,
    on_partial: P,
    on_progress: G,
) -> Result<String, String>
where
    P: FnMut(&str) + 'static,
    G: FnMut(i32) + 'static,
{
    transcribe_local_with_languages(ctx, samples, prompt, language, &[], on_partial, on_progress)
}

/// Auto-detect can be restricted to the user's spoken languages. An empty list
/// preserves Whisper's unrestricted detection; an explicit language takes priority.
#[cfg(feature = "local-stt")]
pub fn transcribe_local_with_languages<P, G>(
    ctx: &whisper_rs::WhisperContext,
    samples: &[f32],
    prompt: Option<&str>,
    language: Option<&str>,
    auto_detect_languages: &[String],
    mut on_partial: P,
    on_progress: G,
) -> Result<String, String>
where
    P: FnMut(&str) + 'static,
    G: FnMut(i32) + 'static,
{
    use whisper_rs::{FullParams, SamplingStrategy};

    let duration_secs = samples.len() as f64 / 16000.0;
    log::debug!(
        "[transcribe] Starting local STT: {} samples ({:.1}s)",
        samples.len(),
        duration_secs
    );

    if samples.len() < 1600 {
        return Err(format!(
            "Audio too short ({:.1}s) — need at least 0.1s",
            duration_secs
        ));
    }

    if !audio_has_signal(samples) {
        log::info!("[transcribe] Local: empty or digitally silent audio, skipping");
        return Ok(String::new());
    }

    let mut state = ctx
        .create_state()
        .map_err(|e| format!("Failed to create state: {}", e))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

    // ── Optimized thread count ──
    let n_threads = std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(4, 8) as i32)
        .unwrap_or(4);
    params.set_n_threads(n_threads);

    let started = std::time::Instant::now();
    let candidates = detection_candidates(language, auto_detect_languages)?;
    let detected = match candidates.as_slice() {
        [] => None,
        [(code, _)] => Some(*code),
        _ => {
            // This replaces Whisper's normal language-detection pass. full()
            // receives an explicit language, so it does not detect a second time.
            state
                .pcm_to_mel(samples, n_threads as usize)
                .map_err(|e| format!("Language detection failed: {e}"))?;
            let (_, probabilities) = state
                .lang_detect(0, n_threads as usize)
                .map_err(|e| format!("Language detection failed: {e}"))?;
            Some(best_detection_language(&candidates, &probabilities)?)
        }
    };
    let chosen_language = language
        .filter(|l| !l.is_empty() && *l != "auto")
        .or(detected);
    params.set_language(chosen_language);
    if let Some(code) = detected {
        log::debug!("[transcribe] Restricted auto-detect selected {code}");
    }

    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    // Longer inputs need timestamp-guided window advancement. Disabling it
    // forces fixed jumps and can skip speech when a window ends mid-sentence.
    // Timestamp tokens remain internal; the returned transcript is plain text.
    params.set_no_timestamps(duration_secs <= 20.0);
    params.set_suppress_nst(true);
    // whisper.cpp skips only when BOTH silence probability is high and
    // average log probability is low. Keep its high-confidence override.
    params.set_no_speech_thold(WHISPER_NO_SPEECH_THRESHOLD);
    params.set_logprob_thold(WHISPER_LOGPROB_THRESHOLD);
    params.set_entropy_thold(2.4);

    // Single segment for short recordings — avoids segment boundary overhead
    if duration_secs <= 20.0 {
        params.set_single_segment(true);
    }

    if let Some(p) = prompt {
        if !p.is_empty() {
            params.set_initial_prompt(p);
            params.set_no_context(false);
        }
    }

    // ── Streaming segment callback — partial text as words appear ──
    let mut accumulated = String::new();
    params.set_segment_callback_safe_lossy(move |data: whisper_rs::SegmentCallbackData| {
        accumulated.push_str(&data.text);
        on_partial(&accumulated);
    });

    // ── Progress callback — 0-100% ──
    params.set_progress_callback_safe(on_progress);

    log::debug!(
        "[transcribe] Params: threads={}, single_seg={}",
        n_threads,
        duration_secs <= 20.0
    );

    state
        .full(params, samples)
        .map_err(|e| format!("Transcription failed: {}", e))?;

    let num_segments = state.full_n_segments();

    let mut text = String::new();

    for i in 0..num_segments {
        if let Some(segment) = state.get_segment(i) {
            match segment.to_str_lossy() {
                Ok(s) => {
                    log::debug!("[transcribe] segment {}: {} chars", i, s.chars().count());
                    text.push_str(&s);
                }
                Err(e) => {
                    log::warn!("[transcribe] segment {} text error: {}", i, e);
                }
            }
        } else {
            log::warn!("[transcribe] segment {} returned None", i);
        }
    }

    let result = text.trim().to_string();
    log::info!(
        "[transcribe] Whisper done in {:.0}ms: {} segments, {} chars",
        started.elapsed().as_millis(),
        num_segments,
        result.chars().count()
    );

    Ok(finish_transcript(&result, "Whisper"))
}

#[cfg(feature = "local-stt")]
fn detection_candidates<'a>(
    language: Option<&str>,
    allowed: &'a [String],
) -> Result<Vec<(&'a str, usize)>, String> {
    if language.is_some_and(|l| !l.is_empty() && l != "auto") {
        return Ok(Vec::new());
    }
    if allowed.len() > 3 {
        return Err("Choose at most three auto-detect languages.".into());
    }
    let mut candidates = Vec::new();
    for code in allowed {
        if code.as_bytes().contains(&0) {
            return Err("Invalid auto-detect language.".into());
        }
        let id = whisper_rs::get_lang_id(code)
            .filter(|_| code != "auto")
            .ok_or_else(|| format!("Unsupported auto-detect language: {code}"))?
            as usize;
        if !candidates.iter().any(|(_, previous)| *previous == id) {
            candidates.push((code.as_str(), id));
        }
    }
    Ok(candidates)
}

#[cfg(feature = "local-stt")]
fn best_detection_language<'a>(
    candidates: &[(&'a str, usize)],
    probabilities: &[f32],
) -> Result<&'a str, String> {
    candidates.iter()
        .filter_map(|(code, id)| probabilities.get(*id).copied().filter(|p| p.is_finite() && *p > 0.0).map(|p| (*code, p)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(code, _)| code)
        .ok_or_else(|| "Could not identify one of your auto-detect languages. Select a spoken language in Settings and try again.".to_string())
}

// ── Local STT via Parakeet (Neural Engine) ──

/// Run Parakeet TDT over `samples`, short-circuiting only digital silence.
/// Whisper's phrase lists and confidence thresholds do not apply to this engine.
/// `language` is an ISO 639-1 hint; "auto"/None lets the model detect it.
/// Parakeet has no vocabulary prompt.
#[cfg(feature = "parakeet")]
pub fn transcribe_parakeet(
    engine: &crate::parakeet::ParakeetEngine,
    samples: &[f32],
    language: Option<&str>,
) -> Result<String, String> {
    let duration_secs = samples.len() as f64 / 16000.0;
    log::debug!(
        "[transcribe] Starting Parakeet: {} samples ({:.1}s)",
        samples.len(),
        duration_secs
    );

    if samples.len() < 1600 {
        return Err(format!(
            "Audio too short ({:.1}s) — need at least 0.1s",
            duration_secs
        ));
    }

    if !audio_has_signal(samples) {
        log::info!("[transcribe] Parakeet: empty or digitally silent audio, skipping");
        return Ok(String::new());
    }

    if !engine.has_speech(samples) {
        log::info!("[transcribe] Parakeet: no speech detected, skipping");
        return Ok(String::new());
    }

    let hint = language.filter(|l| *l != "auto" && !l.is_empty());
    let started = std::time::Instant::now();
    let result = engine.transcribe(samples, hint)?;
    let text = result.text.trim().to_string();
    log::info!(
        "[transcribe] Parakeet done in {:.0}ms (inference {:.0}ms): {} chars",
        started.elapsed().as_millis(),
        result.processing_secs * 1000.0,
        text.chars().count()
    );

    Ok(finish_transcript(&text, "Parakeet"))
}

/// What a local transcription produced: the text, plus any dictionary words the
/// engine itself corrected (Parakeet vocabulary), so the UI can count them.
#[derive(serde::Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Transcription {
    pub text: String,
    pub vocabulary_applied: Vec<crate::vocabulary::AppliedReplacement>,
}

impl From<String> for Transcription {
    fn from(text: String) -> Self {
        Self {
            text,
            vocabulary_applied: Vec::new(),
        }
    }
}

/// Parakeet with dictionary terms: the TDT transcript is rescored against the
/// terms by FluidAudio's CTC keyword spotter, and only candidates that resemble a
/// term (or one of its known wrong spellings) are applied.
#[cfg(feature = "parakeet")]
pub fn transcribe_parakeet_with_vocabulary(
    engine: &crate::parakeet::ParakeetEngine,
    samples: &[f32],
    language: Option<&str>,
    terms: &[crate::vocabulary::VocabTerm],
) -> Result<Transcription, String> {
    let duration_secs = samples.len() as f64 / 16000.0;
    log::debug!(
        "[transcribe] Starting Parakeet with {} dictionary terms: {} samples ({:.1}s)",
        terms.len(),
        samples.len(),
        duration_secs
    );

    if samples.len() < 1600 {
        return Err(format!(
            "Audio too short ({:.1}s) — need at least 0.1s",
            duration_secs
        ));
    }

    if !audio_has_signal(samples) {
        log::info!("[transcribe] Parakeet: empty or digitally silent audio, skipping");
        return Ok(Transcription::default());
    }

    if !engine.has_speech(samples) {
        log::info!("[transcribe] Parakeet: no speech detected, skipping");
        return Ok(Transcription::default());
    }

    let hint = language.filter(|l| *l != "auto" && !l.is_empty());
    let started = std::time::Instant::now();
    let result = engine.transcribe_with_vocabulary(samples, hint, terms)?;
    let (text, applied) =
        crate::vocabulary::apply_replacements(result.text.trim(), &result.replacements, terms);
    let text = text.trim().to_string();
    log::info!(
        "[transcribe] Parakeet done in {:.0}ms (inference {:.0}ms): {} chars; vocabulary candidates {}, applied {}",
        started.elapsed().as_millis(),
        result.processing_secs * 1000.0,
        text.chars().count(),
        result.replacements.len(),
        applied.len()
    );

    Ok(Transcription {
        text: finish_transcript(&text, "Parakeet vocabulary"),
        vocabulary_applied: applied,
    })
}

// ── Model catalog & download ──

/// Which local inference engine a catalog entry runs on.
#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ModelBackend {
    /// whisper.cpp GGML file (Metal on Apple silicon, CPU on Intel).
    Whisper,
    /// NVIDIA Parakeet TDT CoreML bundle (Neural Engine) via FluidAudio.
    Parakeet,
}

/// Bundle id (directory name inside the models dir) for Parakeet TDT 0.6B v3.
/// FluidAudio derives this name from its HuggingFace repo, so it must match.
pub const PARAKEET_V3_ID: &str = "parakeet-tdt-0.6b-v3";

/// Bundle id of the Parakeet CTC 110M keyword-spotter models that let Parakeet
/// recognise dictionary words. FluidAudio keeps the "-coreml" suffix for this one.
pub const PARAKEET_CTC_ID: &str = "parakeet-ctc-110m-coreml";

/// True when `filename` refers to the Parakeet bundle rather than a whisper file.
pub fn is_parakeet_model(filename: &str) -> bool {
    filename == PARAKEET_V3_ID
}

/// Available model variants with download URLs and sizes.
#[derive(serde::Serialize, Clone)]
pub struct ModelInfo {
    pub name: String,
    /// Whisper: GGML filename. Parakeet: bundle directory name.
    pub filename: String,
    /// Whisper: direct download URL. Parakeet: informational (FluidAudio fetches the bundle).
    pub url: String,
    pub size_mb: u64,
    pub description: String,
    pub backend: ModelBackend,
}

/// Catalog shown in Settings/Onboarding, best first. The first entry is the
/// recommended default that onboarding downloads automatically: Parakeet when
/// this build includes the bridge and the machine can run it (Apple Silicon),
/// otherwise whisper Turbo Q5.
pub fn available_models(parakeet_supported: bool) -> Vec<ModelInfo> {
    let mut models = Vec::with_capacity(2);
    if parakeet_supported {
        models.push(ModelInfo {
            name: "Parakeet TDT v3 (~500 MB)".into(),
            filename: PARAKEET_V3_ID.into(),
            url: "https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml".into(),
            size_mb: 500,
            description: "Runs on the Neural Engine · sub-second · 25 European languages · no vocabulary prompt".into(),
            backend: ModelBackend::Parakeet,
        });
    }
    models.push(ModelInfo {
        name: "Whisper Large Turbo Q5 (574 MB)".into(),
        filename: crate::model_store::WHISPER_ID.into(),
        url: crate::model_store::WHISPER_URL.into(),
        size_mb: 574,
        description: if cfg!(target_arch = "aarch64") {
            "Runs on the GPU · supports the vocabulary prompt"
        } else {
            "Runs on the CPU · supports the vocabulary prompt"
        }
        .into(),
        backend: ModelBackend::Whisper,
    });
    models[0].name.push_str(" ★ Recommended");
    models
}

/// Download a model file with progress events.
pub async fn download_model(app: &tauri::AppHandle, dest: &std::path::Path) -> Result<(), String> {
    use crate::model_store::{verify_artifact, WHISPER_BYTES, WHISPER_SHA256, WHISPER_URL};
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use tauri::Emitter;

    // Create parent dir
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }

    let response = download_client()
        .get(WHISPER_URL)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }

    let total_size = WHISPER_BYTES;
    if response
        .content_length()
        .is_some_and(|length| length != total_size)
    {
        return Err("Unexpected model download size.".into());
    }
    let mut digest = Sha256::new();
    let mut downloaded: u64 = 0;

    // Background setup can outlive the onboarding screen. Only expose a model
    // at its final path once complete, so another screen or launch cannot load
    // a partial Whisper download.
    // A unique create-new file cannot follow a pre-existing partial-file symlink.
    // Dropping it after any failure removes the incomplete artifact.
    let mut file = tempfile::NamedTempFile::new_in(dest.parent().ok_or("Invalid model path")?)
        .map_err(|e| format!("Failed to create model download: {e}"))?;

    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        if downloaded + chunk.len() as u64 > total_size {
            return Err("Model download exceeds its expected size.".into());
        }
        digest.update(&chunk);
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|e| format!("File write error: {}", e))?;
        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let progress = (downloaded as f64 / total_size as f64 * 100.0) as u32;
            let _ = app.emit(
                "model-download-progress",
                serde_json::json!({
                    "filename": dest.file_name().and_then(|name| name.to_str()),
                    "downloaded": downloaded,
                    "total": total_size,
                    "progress": progress,
                }),
            );
        }
    }

    verify_artifact(
        downloaded,
        &crate::model_store::sha256_hex(digest.finalize()),
        WHISPER_BYTES,
        WHISPER_SHA256,
    )?;
    file.as_file()
        .sync_all()
        .map_err(|e| format!("Failed to finish model file: {e}"))?;
    file.persist(dest)
        .map_err(|e| format!("Failed to save model file: {e}"))?;

    let _ = app.emit(
        "model-download-complete",
        serde_json::json!({
            "filename": dest.file_name().and_then(|name| name.to_str()),
        }),
    );
    Ok(())
}
