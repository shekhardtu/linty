//! Compare the app's actual local transcription paths and optional VAD gates.
//! stt_guards <whisper|parakeet> <models-dir> <manifest.json> <report.json> [vad-model]
//! --prepare explicitly exercises the production downloader before loading.
//! --vocabulary exercises Parakeet's dictionary entry point with empty terms.
//! --ungated calls the raw Parakeet decoder for a reproducible VAD baseline.
//! Audio must already exist. No recording or app settings changes.
use linty_lib::{parakeet::ParakeetEngine, transcribe};
use serde::Deserialize;
use serde_json::json;
use std::{fs, path::Path, time::Instant};
use whisper_rs::{
    WhisperContext, WhisperContextParameters, WhisperVadContext, WhisperVadContextParams,
    WhisperVadParams,
};

#[derive(Deserialize)]
struct Manifest {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    wav: String,
    text: String,
    speech: bool,
    category: String,
    language: String,
}

fn normalized(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let prepare = raw_args.iter().any(|arg| arg == "--prepare");
    let vocabulary = raw_args.iter().any(|arg| arg == "--vocabulary");
    let ungated = raw_args.iter().any(|arg| arg == "--ungated");
    let args: Vec<String> = raw_args
        .into_iter()
        .filter(|arg| !["--prepare", "--vocabulary", "--ungated"].contains(&arg.as_str()))
        .collect();
    if !(4..=5).contains(&args.len()) || !["whisper", "parakeet"].contains(&args[0].as_str()) {
        return Err("usage: stt_guards <whisper|parakeet> <models-dir> <manifest.json> <report.json> [vad-model]".into());
    }
    if ungated && (vocabulary || args[0] != "parakeet") {
        return Err("--ungated requires plain Parakeet".into());
    }
    let manifest_path = Path::new(&args[2]);
    let manifest: Manifest = serde_json::from_slice(&fs::read(manifest_path)?)?;
    let models = Path::new(&args[1]);
    if prepare && args[0] == "parakeet" {
        linty_lib::parakeet::download(&models.join(transcribe::PARAKEET_V3_ID), |fraction| {
            println!("PREPARE {:.3}", fraction);
        })?;
    }
    let load_started = Instant::now();
    let whisper = if args[0] == "whisper" {
        Some(WhisperContext::new_with_params(
            models
                .join("ggml-large-v3-turbo-q5_0.bin")
                .to_str()
                .ok_or("invalid path")?,
            WhisperContextParameters::default(),
        )?)
    } else {
        None
    };
    let parakeet = if args[0] == "parakeet" {
        Some(ParakeetEngine::load(
            &models.join(transcribe::PARAKEET_V3_ID),
        )?)
    } else {
        None
    };
    if let Some(ctx) = &whisper {
        linty_lib::warm_up_whisper(ctx)?;
    }
    if vocabulary {
        let dir = models.join(transcribe::PARAKEET_CTC_ID);
        if dir.is_dir() {
            parakeet
                .as_ref()
                .ok_or("--vocabulary requires Parakeet")?
                .load_ctc(&dir)?;
        }
    }
    let load_ms = load_started.elapsed().as_secs_f64() * 1000.0;
    let mut results = Vec::new();
    for case in manifest.cases {
        let mut reader = hound::WavReader::open(manifest_path.parent().unwrap().join(&case.wav))?;
        let spec = reader.spec();
        if spec.channels != 1
            || spec.sample_rate != 16000
            || spec.bits_per_sample != 16
            || spec.sample_format != hound::SampleFormat::Int
        {
            return Err("fixtures must be 16 kHz mono 16-bit PCM".into());
        }
        let samples = reader
            .samples::<i16>()
            .map(|s| s.map(|n| n as f32 / 32768.0))
            .collect::<Result<Vec<_>, _>>()?;
        let started = Instant::now();
        let result = if let Some(ctx) = &whisper {
            transcribe::transcribe_local(ctx, &samples, None, Some(&case.language), |_| {}, |_| {})
        } else if ungated {
            if samples.iter().any(|s| s.is_finite() && s.abs() > 1e-10) {
                let language = (case.language != "auto").then_some(case.language.as_str());
                parakeet
                    .as_ref()
                    .unwrap()
                    .transcribe(&samples, language)
                    .map(|result| result.text.trim().to_owned())
            } else {
                Ok(String::new())
            }
        } else if vocabulary {
            transcribe::transcribe_parakeet_with_vocabulary(
                parakeet.as_ref().unwrap(),
                &samples,
                Some(&case.language),
                &[],
            )
            .map(|result| result.text)
        } else {
            transcribe::transcribe_parakeet(
                parakeet.as_ref().unwrap(),
                &samples,
                Some(&case.language),
            )
        };
        // Preserve invalid-input errors in the report instead of aborting the
        // entire evaluation or misreporting an error as correct silence.
        let (text, error) = match result {
            Ok(text) => (text, None),
            Err(error) => (String::new(), Some(error)),
        };
        let inference_ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut vad_results = Vec::new();
        if let Some(model) = args.get(4) {
            // A fresh VAD context per file avoids recurrent-state carryover.
            let mut context_params = WhisperVadContextParams::default();
            context_params.set_use_gpu(false);
            let mut vad = WhisperVadContext::new(model, context_params)?;
            let start = Instant::now();
            vad.detect_speech(&samples)?;
            let max_probability = vad.probabilities().iter().copied().fold(0.0_f32, f32::max);
            for (name, threshold, min_ms) in [
                ("default", 0.5, 250),
                ("lenient", 0.2, 100),
                ("balanced", 0.3, 100),
            ] {
                let mut params = WhisperVadParams::default();
                params.set_threshold(threshold);
                params.set_min_speech_duration(min_ms);
                let segments = vad.segments_from_probabilities(params)?;
                let pass = segments.num_segments() > 0;
                vad_results.push(json!({"policy": name, "threshold": threshold,
                    "min_speech_ms": min_ms, "speech_segments": segments.num_segments(),
                    "max_probability": max_probability, "would_pass": pass,
                    "would_drop_valid_speech": case.speech && !pass,
                    "would_prevent_false_text": !case.speech && !text.is_empty() && !pass,
                    "ms": start.elapsed().as_secs_f64() * 1000.0}));
            }
            let peak = samples
                .iter()
                .copied()
                .map(f32::abs)
                .fold(0.0_f32, f32::max);
            let gain = if peak > 1e-10 {
                (0.1 / peak).clamp(1.0, 1000.0)
            } else {
                1.0
            };
            // A separate context resets recurrent state for the rescue pass.
            // The original ASR input above is never normalized or cropped.
            let mut rescue_params = WhisperVadContextParams::default();
            rescue_params.set_use_gpu(false);
            let mut rescue = WhisperVadContext::new(model, rescue_params)?;
            let boosted: Vec<f32> = samples.iter().map(|s| s * gain).collect();
            rescue.detect_speech(&boosted)?;
            let rescue_max = rescue
                .probabilities()
                .iter()
                .copied()
                .fold(0.0_f32, f32::max);
            for (name, threshold) in [
                ("gain-rescue-0.5", 0.5),
                ("gain-rescue-0.3", 0.3),
                ("gain-rescue-0.2", 0.2),
            ] {
                let mut params = WhisperVadParams::default();
                params.set_threshold(threshold);
                params.set_min_speech_duration(100);
                let original_segments = vad
                    .segments_from_probabilities(params.clone())?
                    .num_segments();
                let rescue_segments = rescue.segments_from_probabilities(params)?.num_segments();
                let pass = original_segments > 0 || rescue_segments > 0;
                vad_results.push(json!({"policy": name, "threshold": threshold,
                    "min_speech_ms": 100, "speech_segments": original_segments,
                    "rescue_segments": rescue_segments, "gain": gain,
                    "max_probability": max_probability, "rescue_max_probability": rescue_max,
                    "would_pass": pass, "would_drop_valid_speech": case.speech && !pass,
                    "would_prevent_false_text": !case.speech && !text.is_empty() && !pass}));
            }
        }
        let value = json!({"name": case.name, "category": case.category,
            "expected_text": case.text, "expected_speech": case.speech,
            "language": case.language, "seconds": samples.len() as f64 / 16000.0,
            "text": text, "error": error, "exact_normalized_match": error.is_none() && (case.speech || text.is_empty())
                && normalized(&text) == normalized(&case.text),
            "speech_presence_correct": error.is_none() && !text.is_empty() == case.speech,
            "inference_ms": inference_ms, "vad": vad_results});
        println!("GUARD {}", value);
        results.push(value);
    }
    fs::write(
        &args[3],
        serde_json::to_vec_pretty(&json!({
            "engine": args[0], "manifest": args[2], "vad_model": args.get(4),
            "vocabulary_entry_point": vocabulary, "ungated": ungated,
            "load_and_preparation_ms": load_ms, "results": results
        }))?,
    )?;
    Ok(())
}
