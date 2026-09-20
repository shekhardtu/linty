//! Side-by-side latency benchmark for Linty's local speech engines.
//!
//! Runs every WAV given on the command line through Whisper (whisper.cpp,
//! Metal) and Parakeet TDT v3 (FluidAudio, Neural Engine) using the exact
//! transcription code paths the app uses, and prints per-file timings.
//!
//! ```bash
//! cd src-tauri
//! cargo run --release --example stt_bench --features local-stt,parakeet -- \
//!     [--models-dir DIR] [--whisper FILE.bin] [--runs N] clip1.wav clip2.wav ...
//! ```
//!
//! Defaults: models dir = Linty's app data models dir, whisper file =
//! ggml-large-v3-turbo-q5_0.bin, 3 runs per file (first run reported separately
//! as the cold run). WAVs must be 16 kHz mono PCM; make one with
//! `say -o clip.aiff "text" && afconvert -f WAVE -d LEI16@16000 -c 1 clip.aiff clip.wav`.
//! The Parakeet bundle is downloaded into the models dir if missing.

use std::path::{Path, PathBuf};
use std::time::Instant;

use linty_lib::transcribe;
use linty_lib::vocabulary;

struct Args {
    models_dir: PathBuf,
    whisper_file: String,
    runs: usize,
    /// Dictionary terms (`Tauri:Tari|Tory,Figma`); when set, Parakeet also runs
    /// with custom-vocabulary rescoring and reports what was applied.
    vocab: Vec<vocabulary::VocabTerm>,
    wavs: Vec<PathBuf>,
}

fn parse_args() -> Args {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut args = Args {
        models_dir: PathBuf::from(home).join("Library/Application Support/ai.linty.desktop/models"),
        whisper_file: "ggml-large-v3-turbo-q5_0.bin".to_string(),
        runs: 3,
        vocab: Vec::new(),
        wavs: Vec::new(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--models-dir" => args.models_dir = PathBuf::from(it.next().expect("--models-dir DIR")),
            "--whisper" => args.whisper_file = it.next().expect("--whisper FILE"),
            "--runs" => args.runs = it.next().expect("--runs N").parse().expect("runs"),
            "--vocab" => {
                args.vocab = it
                    .next()
                    .expect("--vocab Term:alias|alias,Other")
                    .split(',')
                    .filter_map(|spec| {
                        let (text, aliases) = spec.split_once(':').unwrap_or((spec, ""));
                        let text = text.trim();
                        (!text.is_empty()).then(|| vocabulary::VocabTerm {
                            text: text.to_string(),
                            aliases: aliases
                                .split('|')
                                .map(str::trim)
                                .filter(|a| !a.is_empty())
                                .map(String::from)
                                .collect(),
                        })
                    })
                    .collect()
            }
            other => args.wavs.push(PathBuf::from(other)),
        }
    }
    if args.wavs.is_empty() {
        eprintln!("usage: stt_bench [--models-dir DIR] [--whisper FILE.bin] [--runs N] [--vocab Term:alias|alias,Other] clip.wav ...");
        std::process::exit(2);
    }
    args
}

fn read_wav_16k_mono(path: &Path) -> Vec<f32> {
    let mut reader = hound::WavReader::open(path)
        .unwrap_or_else(|e| panic!("cannot open {}: {e}", path.display()));
    let spec = reader.spec();
    assert!(
        spec.sample_rate == 16000 && spec.channels == 1,
        "{} must be 16 kHz mono (got {} Hz, {} ch)",
        path.display(),
        spec.sample_rate,
        spec.channels
    );
    match spec.sample_format {
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.expect("sample") as f32 / max)
                .collect()
        }
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|s| s.expect("sample"))
            .collect(),
    }
}

struct Timing {
    cold_ms: f64,
    warm_ms: Vec<f64>,
    text: String,
}

fn median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return f64::NAN;
    }
    let mut v = xs.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn bench<F: FnMut() -> Result<String, String>>(runs: usize, mut f: F) -> Timing {
    let t = Instant::now();
    let text = f().unwrap_or_else(|e| format!("<error: {e}>"));
    let cold_ms = t.elapsed().as_secs_f64() * 1000.0;
    let mut warm_ms = Vec::new();
    for _ in 1..runs {
        let t = Instant::now();
        let _ = f();
        warm_ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    Timing {
        cold_ms,
        warm_ms,
        text,
    }
}

fn main() {
    let args = parse_args();
    let clips: Vec<(String, Vec<f32>)> = args
        .wavs
        .iter()
        .map(|p| {
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                read_wav_16k_mono(p),
            )
        })
        .collect();

    // ── Whisper ──
    let whisper_path = args.models_dir.join(&args.whisper_file);
    let whisper_ctx = if whisper_path.exists() {
        let t = Instant::now();
        let mut params = whisper_rs::WhisperContextParameters::default();
        params.use_gpu(cfg!(target_arch = "aarch64"));
        let ctx =
            whisper_rs::WhisperContext::new_with_params(whisper_path.to_str().unwrap(), params)
                .expect("load whisper");
        println!(
            "whisper  : loaded {} in {:.0} ms",
            args.whisper_file,
            t.elapsed().as_secs_f64() * 1000.0
        );
        Some(ctx)
    } else {
        println!("whisper  : {} not found, skipping", whisper_path.display());
        None
    };

    // ── Parakeet ──
    let parakeet_dir = args.models_dir.join(transcribe::PARAKEET_V3_ID);
    if !linty_lib::parakeet::models_exist(&parakeet_dir) {
        println!(
            "parakeet : downloading bundle into {} ...",
            parakeet_dir.display()
        );
        let t = Instant::now();
        linty_lib::parakeet::download(&parakeet_dir, |f| {
            eprint!("\r  download+compile {:>3.0}%", f * 100.0);
        })
        .expect("download parakeet");
        eprintln!();
        println!(
            "parakeet : download took {:.1} s",
            t.elapsed().as_secs_f64()
        );
    }
    let t = Instant::now();
    let parakeet = linty_lib::parakeet::ParakeetEngine::load(&parakeet_dir).expect("load parakeet");
    println!(
        "parakeet : loaded in {:.0} ms (includes Neural Engine compile on first load)",
        t.elapsed().as_secs_f64() * 1000.0
    );

    println!();
    println!(
        "{:<28} {:>7} {:<9} {:>9} {:>9}  text",
        "clip", "audio", "engine", "cold ms", "warm ms"
    );
    for (name, samples) in &clips {
        let audio_s = samples.len() as f64 / 16000.0;
        if let Some(ctx) = &whisper_ctx {
            let timing = bench(args.runs, || {
                transcribe::transcribe_local(ctx, samples, None, Some("en"), |_| {}, |_| {})
            });
            println!(
                "{:<28} {:>6.1}s {:<9} {:>9.0} {:>9.0}  {}",
                name,
                audio_s,
                "whisper",
                timing.cold_ms,
                median(&timing.warm_ms),
                timing.text
            );
        }
        let timing = bench(args.runs, || {
            transcribe::transcribe_parakeet(&parakeet, samples, Some("en"))
        });
        println!(
            "{:<28} {:>6.1}s {:<9} {:>9.0} {:>9.0}  {}",
            name,
            audio_s,
            "parakeet",
            timing.cold_ms,
            median(&timing.warm_ms),
            timing.text
        );
    }

    // ── Custom vocabulary pass ──
    if !args.vocab.is_empty() {
        println!();
        println!(
            "vocabulary: {}",
            args.vocab
                .iter()
                .map(|t| t.text.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
        let rss_before = resident_mb();
        // FluidAudio keeps the "-coreml" suffix for this bundle (unlike the v3 TDT bundle).
        let ctc_dir = args.models_dir.join("parakeet-ctc-110m-coreml");
        let t = Instant::now();
        parakeet.load_ctc(&ctc_dir).expect("load CTC models");
        println!(
            "parakeet : CTC keyword-spotter models ready in {:.1} s (download+compile on first run); resident memory {:.0} -> {:.0} MB",
            t.elapsed().as_secs_f64(),
            rss_before,
            resident_mb()
        );
        let terms = args.vocab.clone();
        println!(
            "{:<28} {:>7} {:<9} {:>9} {:>9}  text",
            "clip", "audio", "engine", "cold ms", "warm ms"
        );
        for (name, samples) in &clips {
            let audio_s = samples.len() as f64 / 16000.0;
            let mut accepted: Vec<String> = Vec::new();
            let mut rejected: Vec<String> = Vec::new();
            let timing = bench(args.runs, || {
                let r = parakeet.transcribe_with_vocabulary(samples, Some("en"), &terms)?;
                let (text, applied) =
                    vocabulary::apply_replacements(&r.text, &r.replacements, &terms);
                accepted = applied
                    .iter()
                    .map(|a| format!("{} -> {}", a.from, a.to))
                    .collect();
                rejected = r
                    .replacements
                    .iter()
                    .filter(|c| !applied.iter().any(|a| a.from == c.from && a.to == c.to))
                    .map(|c| format!("{} -> {}", c.from, c.to))
                    .collect();
                Ok(text)
            });
            println!(
                "{:<28} {:>6.1}s {:<9} {:>9.0} {:>9.0}  {}",
                name,
                audio_s,
                "pk+vocab",
                timing.cold_ms,
                median(&timing.warm_ms),
                timing.text
            );
            if !accepted.is_empty() {
                println!(
                    "{:<28} {:>7} {:<9} {:>9} {:>9}  ↳ applied:  {}",
                    "",
                    "",
                    "",
                    "",
                    "",
                    accepted.join(", ")
                );
            }
            if !rejected.is_empty() {
                println!(
                    "{:<28} {:>7} {:<9} {:>9} {:>9}  ↳ rejected: {}",
                    "",
                    "",
                    "",
                    "",
                    "",
                    rejected.join(", ")
                );
            }
        }
    }
}

/// Resident set size of this process in MB (via `ps`).
fn resident_mb() -> f64 {
    std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<f64>().ok())
        .map(|kb| kb / 1024.0)
        .unwrap_or(f64::NAN)
}
