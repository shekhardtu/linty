//! Optional, entirely local S1-mini transcript normalization.
//! Model assets are revision-pinned and verified before an atomic installation.
use candle_core::{quantized::gguf_file, Device, Tensor};
use candle_transformers::models::quantized_qwen3::ModelWeights;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tokenizers::Tokenizer;

pub const MODEL_ID: &str = "superwhisper/s1-mini-GGUF";
pub const REVISION: &str = "34add00a48a2e5d24e5a4ee5405a99620a3a240c";
const TOKENIZER_REVISION: &str = "88f6b15896c73bbb13a3b596e0afe8ea0d5150b4";
const MODEL_FILE: &str = "s1-mini-q4_k_m.gguf";
const MODEL_BYTES: u64 = 484_219_808;
const TOKENIZER_BYTES: u64 = 11_422_654;
const SYSTEM: &str = "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.";
const CHUNK_TOKENS: usize = 700;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    chip: Option<String>,
    memory_bytes: Option<u64>,
    os_version: Option<String>,
    logical_cpus: usize,
}
fn hardware() -> Hardware {
    static HARDWARE: OnceLock<Hardware> = OnceLock::new();
    HARDWARE
        .get_or_init(|| {
            #[cfg(target_os = "macos")]
            let read = |program: &str, args: &[&str]| {
                std::process::Command::new(program)
                    .args(args)
                    .output()
                    .ok()
                    .filter(|r| r.status.success())
                    .and_then(|r| String::from_utf8(r.stdout).ok())
                    .map(|s| s.trim().to_owned())
            };
            Hardware {
                #[cfg(target_os = "macos")]
                chip: read("/usr/sbin/sysctl", &["-n", "machdep.cpu.brand_string"]),
                #[cfg(not(target_os = "macos"))]
                chip: None,
                #[cfg(target_os = "macos")]
                memory_bytes: read("/usr/sbin/sysctl", &["-n", "hw.memsize"])
                    .and_then(|s| s.parse().ok()),
                #[cfg(not(target_os = "macos"))]
                memory_bytes: None,
                #[cfg(target_os = "macos")]
                os_version: read("/usr/bin/sw_vers", &["-productVersion"]),
                #[cfg(not(target_os = "macos"))]
                os_version: None,
                logical_cpus: std::thread::available_parallelism().map_or(1, |n| n.get()),
            }
        })
        .clone()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub styling: String,
    pub structure: String,
    pub context: String,
}
impl Options {
    fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            ["casual", "semi-casual", "semi-formal", "formal"].contains(&self.styling.as_str()),
            "Invalid style"
        );
        anyhow::ensure!(
            ["prose", "lists"].contains(&self.structure.as_str()),
            "Invalid structure"
        );
        anyhow::ensure!(
            ["general", "email"].contains(&self.context.as_str()),
            "Invalid context"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub schema_version: u8,
    pub model_id: &'static str,
    pub model_revision: &'static str,
    pub tokenizer_revision: &'static str,
    pub quantization: &'static str,
    pub prompt_version: u8,
    pub runtime: &'static str,
    pub backend: String,
    pub app_version: &'static str,
    pub architecture: &'static str,
    pub hardware: Hardware,
    pub model_bytes: u64,
    pub status: String,
    pub reason: Option<String>,
    pub requested_language: String,
    pub detected_language: Option<String>,
    pub language_confidence: Option<f64>,
    pub options: Options,
    pub total_ms: f64,
    pub model_load_ms: f64,
    pub prefill_ms: f64,
    pub decode_ms: f64,
    pub first_token_ms: Option<f64>,
    pub input_tokens: usize,
    pub prompt_tokens: usize,
    pub generated_tokens: usize,
    pub decode_tokens: usize,
    pub tokens_per_second: Option<f64>,
    pub chunks: usize,
    pub completed_chunks: usize,
    pub input_words: usize,
    pub output_words: usize,
    pub input_characters: usize,
    pub output_characters: usize,
    pub changed: bool,
}
impl Metrics {
    pub(crate) fn new(text: &str, language: &str, options: Options) -> Self {
        Self {
            schema_version: 1,
            model_id: MODEL_ID,
            model_revision: REVISION,
            tokenizer_revision: TOKENIZER_REVISION,
            quantization: "Q4_K_M",
            prompt_version: 1,
            runtime: "candle-0.11.0",
            backend: "unloaded".into(),
            app_version: env!("CARGO_PKG_VERSION"),
            architecture: std::env::consts::ARCH,
            model_bytes: MODEL_BYTES,
            hardware: hardware(),
            status: "skipped".into(),
            reason: None,
            requested_language: language.into(),
            detected_language: None,
            language_confidence: None,
            options,
            total_ms: 0.,
            model_load_ms: 0.,
            prefill_ms: 0.,
            decode_ms: 0.,
            first_token_ms: None,
            input_tokens: 0,
            prompt_tokens: 0,
            generated_tokens: 0,
            decode_tokens: 0,
            tokens_per_second: None,
            chunks: 0,
            completed_chunks: 0,
            input_words: text.split_whitespace().count(),
            output_words: text.split_whitespace().count(),
            input_characters: text.chars().count(),
            output_characters: text.chars().count(),
            changed: false,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReformatResult {
    /// Always usable: the complete original is returned on any failure.
    pub text: String,
    pub metrics: Metrics,
}

pub struct Engine {
    model: ModelWeights,
    tokenizer: Tokenizer,
    device: Device,
    eos: u32,
    warmed_up: bool,
}
impl Engine {
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        anyhow::ensure!(installed(dir), "model_not_downloaded");
        // Verify again when opening weights, including installations modified on disk.
        verify_file(
            &dir.join(MODEL_FILE),
            "3b41ebe2502cbd03e811d5d16b022f5ab551eda58d62597d152f89535003c634",
        )?;
        verify_file(
            &dir.join("tokenizer.json"),
            "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
        )?;
        #[cfg(target_os = "macos")]
        let device = Device::new_metal(0).unwrap_or(Device::Cpu);
        #[cfg(not(target_os = "macos"))]
        let device = Device::Cpu;
        let mut file = fs::File::open(dir.join(MODEL_FILE))?;
        let mut content = gguf_file::Content::read(&mut file)?;
        // Bound rotary tables to our actual context and use the dequantized F32 dtype.
        content
            .metadata
            .insert("qwen3.context_length".into(), gguf_file::Value::U32(4096));
        content
            .metadata
            .insert("general.dtype".into(), gguf_file::Value::U32(0));
        let model = ModelWeights::from_gguf(content, &mut file, &device)?;
        let tokenizer =
            Tokenizer::from_file(dir.join("tokenizer.json")).map_err(|e| anyhow::anyhow!("{e}"))?;
        let eos = tokenizer
            .token_to_id("<|im_end|>")
            .ok_or_else(|| anyhow::anyhow!("missing_end_token"))?;
        Ok(Self {
            model,
            tokenizer,
            device,
            eos,
            warmed_up: false,
        })
    }

    /// Exercise prefill and cached decoding before accepting real transcripts.
    /// The synthetic prompt and its KV cache never reach history or the clipboard.
    fn warm_up(&mut self, check_cancelled: &impl Fn() -> bool) -> anyhow::Result<()> {
        if self.warmed_up {
            return Ok(());
        }
        let started = Instant::now();
        let check = || -> anyhow::Result<()> {
            anyhow::ensure!(!check_cancelled(), "cancelled");
            anyhow::ensure!(
                started.elapsed() < Duration::from_secs(60),
                "warmup_timeout"
            );
            Ok(())
        };
        self.model.clear_kv_cache();
        let result = (|| {
            check()?;
            let options = Options {
                styling: "semi-formal".into(),
                structure: "lists".into(),
                context: "general".into(),
            };
            let mut current = self.tokens(&prompt(
                "please send the report on monday and include the budget the timeline and the risks",
                &options,
            ))?;
            let mut position = 0;
            // Prefill plus two decode passes initializes both Metal paths,
            // including attention over an existing cache. Output is discarded.
            for _ in 0..3 {
                check()?;
                let input = Tensor::new(current.as_slice(), &self.device)?.unsqueeze(0)?;
                let logits = self.model.forward(&input, position)?;
                let token = logits.squeeze(0)?.argmax(0)?.to_scalar::<u32>()?;
                position += current.len();
                current = vec![token];
                check()?;
            }
            self.device.synchronize()?;
            check()
        })();
        self.model.clear_kv_cache();
        if result.is_ok() {
            self.warmed_up = true;
            log::info!(
                "[s1] Inference warm-up complete in {}ms",
                started.elapsed().as_millis()
            );
        }
        result
    }

    fn tokens(&self, text: &str) -> anyhow::Result<Vec<u32>> {
        Ok(self
            .tokenizer
            .encode(text, false)
            .map_err(|e| anyhow::anyhow!("{e}"))?
            .get_ids()
            .to_vec())
    }

    fn generate(
        &mut self,
        text: &str,
        metrics: &mut Metrics,
        check: &impl Fn() -> anyhow::Result<()>,
        started: Instant,
    ) -> anyhow::Result<String> {
        self.model.clear_kv_cache();
        let result = (|| {
            let input = self.tokens(&prompt(text, &metrics.options))?;
            metrics.prompt_tokens += input.len();
            let max_output = (self.tokens(text)?.len() * 2 + 64).min(1500);
            anyhow::ensure!(input.len() + max_output < 4096, "context_limit");
            let mut generated = Vec::new();
            let mut position = 0;
            let mut current = input;
            for step in 0..max_output {
                check()?;
                let tick = Instant::now();
                let tensor = Tensor::new(current.as_slice(), &self.device)?.unsqueeze(0)?;
                let logits = self.model.forward(&tensor, position)?;
                let token = logits.squeeze(0)?.argmax(0)?.to_scalar::<u32>()?;
                let elapsed = tick.elapsed().as_secs_f64() * 1000.;
                if step == 0 {
                    metrics.prefill_ms += elapsed;
                    metrics
                        .first_token_ms
                        .get_or_insert(started.elapsed().as_secs_f64() * 1000.);
                } else {
                    metrics.decode_ms += elapsed;
                    metrics.decode_tokens += 1;
                }
                check()?;
                if token == self.eos {
                    return self
                        .tokenizer
                        .decode(&generated, true)
                        .map_err(|e| anyhow::anyhow!("{e}"));
                }
                generated.push(token);
                metrics.generated_tokens += 1;
                position += current.len();
                current = vec![token];
            }
            anyhow::bail!("output_limit")
        })();
        // No transcript/KV cache is kept between requests, including failed ones.
        self.model.clear_kv_cache();
        result
    }
}

fn prompt(text: &str, options: &Options) -> String {
    format!("<|im_start|>system\n{SYSTEM}<|im_end|>\n<|im_start|>user\n[Styling: {}] [Structure: {}] [Context: {}]\n{text}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n", options.styling, options.structure, options.context)
}

/// Split at whitespace without losing or altering any input bytes. Each chunk is
/// within the model's training range. No partial rewrite is used on failure.
fn chunks<'a>(
    text: &'a str,
    count: impl Fn(&str) -> anyhow::Result<usize>,
) -> anyhow::Result<Vec<&'a str>> {
    let mut result = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        if count(rest)? <= CHUNK_TOKENS {
            result.push(rest);
            break;
        }
        let boundaries: Vec<usize> = rest
            .char_indices()
            .filter_map(|(i, c)| c.is_whitespace().then_some(i + c.len_utf8()))
            .collect();
        let mut low = 0;
        let mut high = boundaries.len();
        while low < high {
            let mid = (low + high) / 2;
            if count(&rest[..boundaries[mid]])? <= CHUNK_TOKENS {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        anyhow::ensure!(low > 0, "unbroken_input_too_long");
        let end = boundaries[low - 1];
        result.push(&rest[..end]);
        rest = &rest[end..];
    }
    Ok(result)
}

/// An empty model response is valid only for unambiguous hesitation sounds.
/// Split on ordinary speech punctuation, not arbitrary nonletters: digits,
/// symbols, quotes, and unknown words must keep the empty-output safeguard.
/// Uppercase UM/UH may be initials, so only normal sentence casing is accepted.
pub(crate) fn is_filler_only(input: &str) -> bool {
    let mut found = false;
    for word in input
        .split(|c: char| c.is_whitespace() || ",.!?…—–-".contains(c))
        .filter(|word| !word.is_empty())
    {
        if !matches!(word, "um" | "Um" | "uh" | "Uh") {
            return false;
        }
        found = true;
    }
    found
}

fn validate_output(input: &str, output: &str) -> anyhow::Result<()> {
    let result = crate::text_validation::validate(input, output);
    anyhow::ensure!(result.status != "fallback", "{}", result.reasons.join(","));
    Ok(())
}

#[derive(Default)]
pub struct ReformatState {
    engine: Arc<Mutex<Option<Engine>>>,
    generation: Arc<AtomicU64>,
    last_used: AtomicU64,
    download_progress: AtomicU64,
    download: tokio::sync::Mutex<()>,
}
impl ReformatState {
    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    pub fn unload_if_idle(&self, now: u64, idle_ms: u64) -> bool {
        if idle_ms > 0 && now.saturating_sub(self.last_used.load(Ordering::Relaxed)) > idle_ms {
            if let Ok(mut engine) = self.engine.try_lock() {
                // Preparation may have refreshed last_used while we acquired
                // the slot. Never unload a just-warmed instance on a stale age.
                if now.saturating_sub(self.last_used.load(Ordering::Relaxed)) > idle_ms {
                    return engine.take().is_some();
                }
            }
        }
        false
    }
}

fn model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models")
        .join("s1-mini"))
}
fn installed(dir: &Path) -> bool {
    fs::read_to_string(dir.join("ready")).is_ok_and(|s| s == REVISION)
        && fs::metadata(dir.join(MODEL_FILE)).is_ok_and(|m| m.len() == MODEL_BYTES)
        && fs::metadata(dir.join("tokenizer.json")).is_ok_and(|m| m.len() == TOKENIZER_BYTES)
}
fn verify_file(path: &Path, expected: &str) -> anyhow::Result<()> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buf = vec![0; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    anyhow::ensure!(
        crate::model_store::sha256_hex(hash.finalize()) == expected,
        "download_checksum_mismatch"
    );
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub(crate) downloaded: bool,
    loaded: bool,
    downloading: bool,
    progress: f64,
    download_bytes: u64,
}
#[tauri::command]
pub fn s1_model_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReformatState>,
) -> Result<ModelStatus, String> {
    Ok(ModelStatus {
        downloaded: installed(&model_dir(&app)?),
        loaded: state.engine.try_lock().is_ok_and(|e| e.is_some()),
        downloading: state.download.try_lock().is_err(),
        progress: state.download_progress.load(Ordering::Relaxed) as f64
            / (MODEL_BYTES + TOKENIZER_BYTES) as f64
            * 100.,
        download_bytes: MODEL_BYTES + TOKENIZER_BYTES,
    })
}

#[tauri::command]
pub async fn download_s1_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReformatState>,
) -> Result<(), String> {
    let _guard = state
        .download
        .try_lock()
        .map_err(|_| "S1-mini is already downloading")?;
    let expected = state.generation.load(Ordering::SeqCst);
    state.download_progress.store(0, Ordering::Relaxed);
    let dir = model_dir(&app)?;
    let result: anyhow::Result<()> = async {
        use tokio::io::AsyncWriteExt;
        tokio::fs::create_dir_all(&dir).await?;
        if installed(&dir) { return Ok(()); }
        let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(30)).timeout(Duration::from_secs(1800)).build()?;
        let assets = [
            (MODEL_FILE, format!("https://huggingface.co/{MODEL_ID}/resolve/{REVISION}/{MODEL_FILE}"), MODEL_BYTES, "3b41ebe2502cbd03e811d5d16b022f5ab551eda58d62597d152f89535003c634"),
            ("tokenizer.json", format!("https://huggingface.co/superwhisper/s1-mini/resolve/{TOKENIZER_REVISION}/tokenizer.json"), TOKENIZER_BYTES, "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4"),
        ];
        let mut completed = 0u64;
        let mut last_event = Instant::now();
        for (name, url, size, sha) in assets {
            let part = dir.join(format!("{name}.part"));
            let mut output = tokio::fs::File::create(&part).await?;
            let mut stream = client.get(url).send().await?.error_for_status()?.bytes_stream();
            let mut downloaded = 0;
            let mut hash = Sha256::new();
            while let Some(chunk) = stream.next().await {
                anyhow::ensure!(state.generation.load(Ordering::SeqCst) == expected, "Download cancelled");
                let chunk = chunk?;
                downloaded += chunk.len() as u64;
                anyhow::ensure!(downloaded <= size, "Unexpected model download size");
                output.write_all(&chunk).await?;
                hash.update(&chunk);
                state.download_progress.store(completed + downloaded, Ordering::Relaxed);
                if last_event.elapsed() > Duration::from_millis(100) {
                    let _ = app.emit("s1-download-progress", (completed + downloaded) as f64 / (MODEL_BYTES + TOKENIZER_BYTES) as f64 * 100.);
                    last_event = Instant::now();
                }
            }
            anyhow::ensure!(downloaded == size && crate::model_store::sha256_hex(hash.finalize()) == sha, "S1-mini download verification failed. Try again.");
            output.sync_all().await?;
            drop(output);
            tokio::fs::rename(part, dir.join(name)).await?;
            completed += downloaded;
        }
        anyhow::ensure!(state.generation.load(Ordering::SeqCst) == expected, "Download cancelled");
        tokio::fs::write(dir.join("LICENSE"), include_str!("../licenses/s1-mini/LICENSE")).await?;
        tokio::fs::write(dir.join("NOTICE"), include_str!("../licenses/s1-mini/NOTICE")).await?;
        tokio::fs::write(dir.join("ready"), REVISION).await?;
        let _ = app.emit("s1-download-progress", 100.);
        Ok(())
    }.await;
    if result.is_err() {
        for name in [MODEL_FILE, "tokenizer.json"] {
            let _ = tokio::fs::remove_file(dir.join(format!("{name}.part"))).await;
        }
    }
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn prepare_s1_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReformatState>,
) -> Result<(), String> {
    let dir = model_dir(&app)?;
    let engine = state.engine.clone();
    let generation = state.generation.clone();
    let expected = generation.load(Ordering::SeqCst);
    state
        .last_used
        .store(crate::now_epoch_ms(), Ordering::Relaxed);
    let result = tokio::task::spawn_blocking(move || {
        let mut slot = engine.lock().map_err(|e| e.to_string())?;
        prepare(&mut slot, &dir, || {
            generation.load(Ordering::SeqCst) != expected
        })
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    // Start the idle interval after preparation, even when a slow first load
    // takes a significant part of that interval.
    state
        .last_used
        .store(crate::now_epoch_ms(), Ordering::Relaxed);
    result
}

/// Shared by the background command and the native benchmark. The caller holds
/// the engine lock, so concurrent preparation/inference cannot duplicate work.
pub fn prepare(
    engine: &mut Option<Engine>,
    dir: &Path,
    check_cancelled: impl Fn() -> bool,
) -> anyhow::Result<()> {
    anyhow::ensure!(!check_cancelled(), "cancelled");
    if engine.is_none() {
        let started = Instant::now();
        let model = Engine::load(dir)?;
        anyhow::ensure!(!check_cancelled(), "cancelled");
        log::info!("[s1] Model loaded in {}ms", started.elapsed().as_millis());
        *engine = Some(model);
    }
    engine.as_mut().unwrap().warm_up(&check_cancelled)
}

#[tauri::command]
pub async fn unload_s1_model(state: tauri::State<'_, ReformatState>) -> Result<(), String> {
    state.cancel();
    let engine = state.engine.clone();
    tokio::task::spawn_blocking(move || {
        engine.lock().map_err(|e| e.to_string())?.take();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cancel_reformatting(state: tauri::State<'_, ReformatState>) {
    state.cancel();
}

/// Auto-detect is eligible only after the text passes the English confidence check.
pub(crate) fn supports_language(language: &str) -> bool {
    matches!(language, "en" | "auto")
}

pub fn run(
    engine: &mut Option<Engine>,
    dir: &Path,
    text: &str,
    language: &str,
    options: Options,
    check_cancelled: impl Fn() -> bool,
) -> ReformatResult {
    let started = Instant::now();
    let mut metrics = Metrics::new(text, language, options);
    let mut result_text = text.to_owned();
    let work = (|| -> anyhow::Result<Option<String>> {
        metrics.options.validate()?;
        anyhow::ensure!(text.len() <= 200_000, "input_too_long");
        if text.trim().is_empty() {
            metrics.reason = Some("empty_input".into());
            return Ok(None);
        }
        if !supports_language(language) {
            metrics.reason = Some("unsupported_language".into());
            return Ok(None);
        }
        if language == "auto" {
            if let Some(info) = whatlang::detect(text) {
                metrics.detected_language = Some(info.lang().code().into());
                metrics.language_confidence = Some(info.confidence());
                if info.lang() != whatlang::Lang::Eng || !info.is_reliable() {
                    metrics.reason = Some("language_not_confidently_english".into());
                    return Ok(None);
                }
            } else {
                metrics.reason = Some("language_unknown".into());
                return Ok(None);
            }
        }
        anyhow::ensure!(!text.contains("<|"), "reserved_tokens_in_input");
        let budget = Duration::from_secs_f64((20. + metrics.input_words as f64 * 0.015).min(120.));
        let check = || -> anyhow::Result<()> {
            anyhow::ensure!(!check_cancelled(), "cancelled");
            anyhow::ensure!(started.elapsed() < budget, "timeout");
            Ok(())
        };
        check()?;
        if engine.is_none() {
            let tick = Instant::now();
            let loaded = Engine::load(dir);
            metrics.model_load_ms = tick.elapsed().as_secs_f64() * 1000.;
            *engine = Some(loaded?);
        }
        check()?;
        let engine = engine
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("model_not_loaded"))?;
        metrics.backend = if engine.device.is_metal() {
            "metal"
        } else {
            "cpu"
        }
        .into();
        metrics.input_tokens = engine.tokens(text)?.len();
        let pieces = chunks(text, |s| Ok(engine.tokens(s)?.len()))?;
        metrics.chunks = pieces.len();
        let mut outputs = Vec::new();
        for piece in pieces {
            check()?;
            let output = engine.generate(piece, &mut metrics, &check, started)?;
            validate_output(piece, &output)?;
            // A completed filler-only chunk contributes no text or separators.
            if !output.trim().is_empty() {
                outputs.push(output.trim().to_owned());
            }
            metrics.completed_chunks += 1;
        }
        Ok(Some(outputs.join("\n\n")))
    })();
    match work {
        Ok(Some(output)) => {
            if output.is_empty() {
                metrics.reason = Some("filler_only".into());
            }
            metrics.changed = output != text;
            metrics.status = if metrics.changed {
                "applied"
            } else {
                "unchanged"
            }
            .into();
            result_text = output;
        }
        Ok(None) => (),
        Err(error) => {
            metrics.status = "fallback".into();
            // Errors contain no input/output text. No raw transcript is logged.
            metrics.reason = Some(error.to_string());
        }
    }
    metrics.total_ms = started.elapsed().as_secs_f64() * 1000.;
    metrics.tokens_per_second =
        (metrics.decode_ms > 0.).then(|| metrics.decode_tokens as f64 * 1000. / metrics.decode_ms);
    metrics.output_words = result_text.split_whitespace().count();
    metrics.output_characters = result_text.chars().count();
    ReformatResult {
        text: result_text,
        metrics,
    }
}

#[tauri::command]
pub async fn reformat_transcript(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReformatState>,
    text: String,
    language: String,
    options: Options,
) -> Result<ReformatResult, String> {
    let dir = model_dir(&app)?;
    let engine = state.engine.clone();
    let generation = state.generation.clone();
    let expected = generation.load(Ordering::SeqCst);
    state
        .last_used
        .store(crate::now_epoch_ms(), Ordering::Relaxed);
    let output = tokio::task::spawn_blocking(move || {
        let mut slot = engine.lock().map_err(|e| e.to_string())?;
        Ok(run(&mut slot, &dir, &text, &language, options, || {
            generation.load(Ordering::SeqCst) != expected
        }))
    })
    .await
    .map_err(|e| e.to_string())?;
    state
        .last_used
        .store(crate::now_epoch_ms(), Ordering::Relaxed);
    output
}

#[cfg(test)]
mod tests {
    // Production owns one S1 engine behind a mutex. Asset tests must not race
    // separate Metal engines against each other's inference deadlines.
    static MODEL_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    use super::*;
    fn options() -> Options {
        Options {
            styling: "semi-formal".into(),
            structure: "lists".into(),
            context: "general".into(),
        }
    }
    #[test]
    fn template_has_exact_controls_and_disabled_thinking() {
        let rendered = prompt("Buy apples.", &options());
        assert!(rendered.contains(
            "[Styling: semi-formal] [Structure: lists] [Context: general]\nBuy apples.<|im_end|>"
        ));
        assert!(rendered.ends_with("<|im_start|>assistant\n<think>\n\n</think>\n\n"));
    }
    #[test]
    fn hindi_is_skipped_even_when_the_recognizer_returns_latin_text() {
        for text in [
            "आप क्या कर रहे हो?",
            "Aap kya kar rahe ho?",
            "Unexpected Latin output",
        ] {
            let mut engine = None;
            let out = run(
                &mut engine,
                Path::new("/nonexistent"),
                text,
                "hi",
                options(),
                || false,
            );
            assert_eq!(out.text, text);
            assert_eq!(out.metrics.status, "skipped");
            assert_eq!(out.metrics.reason.as_deref(), Some("unsupported_language"));
            assert_eq!(out.metrics.generated_tokens, 0);
            assert!(engine.is_none());
        }
    }
    #[test]
    fn unsupported_language_and_missing_model_preserve_all_text() {
        let text = "This is the complete original transcript, including every word.";
        let out = run(
            &mut None,
            Path::new("/nonexistent"),
            text,
            "de",
            options(),
            || false,
        );
        assert_eq!(out.text, text);
        assert_eq!(out.metrics.status, "skipped");
        let out = run(
            &mut None,
            Path::new("/nonexistent"),
            text,
            "en",
            options(),
            || false,
        );
        assert_eq!(out.text, text);
        assert_eq!(out.metrics.status, "fallback");
        assert!(out.metrics.reason.unwrap().contains("model_not_downloaded"));
    }
    #[test]
    fn cancellation_precedes_model_load() {
        let out = run(
            &mut None,
            Path::new("/nonexistent"),
            "Keep my original.",
            "en",
            options(),
            || true,
        );
        assert_eq!(out.text, "Keep my original.");
        assert_eq!(out.metrics.reason.as_deref(), Some("cancelled"));
    }
    #[test]
    fn preparation_cancellation_precedes_model_load() {
        let mut engine = None;
        let error = prepare(&mut engine, Path::new("/nonexistent"), || true).unwrap_err();
        assert_eq!(error.to_string(), "cancelled");
        assert!(engine.is_none());
    }

    #[test]
    #[ignore = "requires installed S1-mini assets via LINTY_S1_TEST_MODEL_DIR"]
    fn warmup_is_retryable_idempotent_and_does_not_change_real_output() {
        let _guard = MODEL_TEST_LOCK.lock().unwrap();
        let dir = PathBuf::from(std::env::var("LINTY_S1_TEST_MODEL_DIR").unwrap());
        let mut engine = Engine::load(&dir).unwrap();
        assert!(engine.warm_up(&|| true).is_err());
        assert!(!engine.warmed_up);
        engine.warm_up(&|| false).unwrap();
        assert!(engine.warmed_up);
        let mut slot = Some(engine);
        prepare(&mut slot, &dir, || false).unwrap();
        let text =
            "um please send the report on monday and include the budget the timeline and the risks";
        let warmed = run(&mut slot, &dir, text, "en", options(), || false);
        assert_ne!(warmed.metrics.status, "fallback");
        assert_eq!(warmed.metrics.model_load_ms, 0.);
        let fresh = run(&mut None, &dir, text, "en", options(), || false);
        assert_ne!(fresh.metrics.status, "fallback");
        assert_eq!(warmed.text, fresh.text);
        assert_eq!(
            warmed.metrics.generated_tokens,
            fresh.metrics.generated_tokens
        );
    }
    #[test]
    fn chunking_preserves_unicode_and_bounds() {
        let text = "café and tea. ".repeat(500);
        let pieces = chunks(&text, |s| Ok(s.chars().count())).unwrap();
        assert_eq!(pieces.concat(), text);
        assert!(pieces.iter().all(|p| p.chars().count() <= CHUNK_TOKENS));
        assert!(chunks(&"x".repeat(701), |s| Ok(s.len())).is_err());
    }
    #[test]
    fn reject_incomplete_or_control_output() {
        assert!(validate_output("hello", "").is_err());
        assert!(validate_output("hello", "<think>hello</think>").is_err());
        assert!(validate_output(&"word ".repeat(40), "Word.").is_err());
        assert!(validate_output("um buy apples and bread", "Buy apples and bread.").is_ok());
    }

    #[test]
    fn empty_cleanup_requires_only_recognizable_fillers() {
        for input in ["um uh um", "Um, uh… um.", "Uh—um!", &"um uh ".repeat(40)] {
            assert!(validate_output(input, " \n").is_ok(), "{input:?}");
        }
        // Short answers, expressive interjections, quoted words, initials,
        // symbols, and meaningful speech must never be discarded as fillers.
        for input in [
            "",
            "...",
            "no",
            "yes",
            "hmm",
            "oh",
            "uh huh",
            "UM",
            "UH",
            "\"um\"",
            "‘uh’",
            "um 5",
            "um ₹",
            "um 🙂",
            "um don't send it",
            "um uh send the report",
            "say um",
            "Umwelt",
            "うむ",
        ] {
            assert!(validate_output(input, "").is_err(), "{input:?}");
        }
    }

    #[test]
    #[ignore = "requires installed S1-mini assets via LINTY_S1_TEST_MODEL_DIR"]
    fn filler_only_model_result_is_applied_and_next_dictation_survives() {
        let _guard = MODEL_TEST_LOCK.lock().unwrap();
        let dir = PathBuf::from(std::env::var("LINTY_S1_TEST_MODEL_DIR").unwrap());
        let mut engine = None;
        let empty = run(&mut engine, &dir, "um uh um", "en", options(), || false);
        assert_eq!(empty.text, "");
        assert_eq!(empty.metrics.status, "applied");
        assert_eq!(empty.metrics.reason.as_deref(), Some("filler_only"));
        assert_eq!(empty.metrics.output_words, 0);
        assert_eq!(empty.metrics.output_characters, 0);
        assert_eq!(empty.metrics.completed_chunks, empty.metrics.chunks);
        let next = run(&mut engine, &dir, "no", "en", options(), || false);
        assert_eq!(next.text, "No.");
        assert_eq!(next.metrics.status, "applied");
        assert_eq!(next.metrics.reason, None);
    }
}
