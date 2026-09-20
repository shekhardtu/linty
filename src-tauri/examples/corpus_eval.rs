//! Public corpus runner using production STT, one resident engine per process.
//! corpus_eval <whisper|parakeet> <models-dir> <manifest.json> <results.jsonl>
//! No downloads, microphone, cleanup, dictionary, history, or clipboard access.
use anyhow::{anyhow, ensure, Context, Result};
use linty_lib::{parakeet::ParakeetEngine, sha256_hex, transcribe};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Write, path::Path, time::Instant};

#[derive(Deserialize)]
struct Manifest {
    schema_version: u32,
    language: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    id: String,
    wav: String,
    audio_sha256: String,
}

fn emit(file: &mut fs::File, value: Value) -> Result<()> {
    serde_json::to_writer(&mut *file, &value)?;
    writeln!(file)?;
    file.flush()?;
    Ok(())
}

fn read_audio(base: &Path, case: &Case) -> Result<Vec<f32>> {
    let relative = Path::new(&case.wav);
    ensure!(
        !relative.is_absolute()
            && relative
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_))),
        "audio path must be relative without traversal"
    );
    let path = base.join(relative).canonicalize()?;
    ensure!(
        path.starts_with(base.canonicalize()?),
        "audio escapes corpus"
    );
    let bytes = fs::read(path)?;
    ensure!(
        sha256_hex(Sha256::digest(&bytes)) == case.audio_sha256,
        "audio checksum mismatch"
    );
    let mut reader = hound::WavReader::new(std::io::Cursor::new(bytes))?;
    let spec = reader.spec();
    ensure!(
        spec.channels == 1
            && spec.sample_rate == 16000
            && spec.bits_per_sample == 16
            && spec.sample_format == hound::SampleFormat::Int,
        "audio must be 16 kHz mono 16-bit PCM WAV"
    );
    let samples = reader
        .samples::<i16>()
        .map(|sample| sample.map(|n| n as f32 / 32768.0))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ensure!(!samples.is_empty(), "empty audio");
    Ok(samples)
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    ensure!(
        args.len() == 4 && ["whisper", "parakeet"].contains(&args[0].as_str()),
        "usage: corpus_eval <whisper|parakeet> <models-dir> <manifest.json> <results.jsonl>"
    );
    let manifest_path = Path::new(&args[2]);
    let bytes = fs::read(manifest_path)?;
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    ensure!(
        manifest.schema_version == 1 && manifest.language == "en",
        "expected English corpus v1"
    );
    ensure!(!manifest.cases.is_empty(), "empty corpus");
    let mut ids = HashSet::new();
    ensure!(
        manifest
            .cases
            .iter()
            .all(|case| !case.id.is_empty() && ids.insert(&case.id)),
        "duplicate or empty case ID"
    );
    let base = manifest_path.parent().context("manifest has no parent")?;
    let models = Path::new(&args[1]);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&args[3])?;
    emit(
        &mut file,
        json!({"type":"start", "schema_version":1, "engine":args[0],
        "manifest_sha256":sha256_hex(Sha256::digest(&bytes)), "expected_cases":manifest.cases.len(),
        "language":"en", "cleanup":false, "dictionary":false, "context_prompt":false,
        "production_speech_guards":true, "profile":if cfg!(debug_assertions) {"debug"} else {"release"}}),
    )?;
    let load_started = Instant::now();
    let whisper = if args[0] == "whisper" {
        let mut params = whisper_rs::WhisperContextParameters::default();
        params.use_gpu(true);
        Some(whisper_rs::WhisperContext::new_with_params(
            models
                .join("ggml-large-v3-turbo-q5_0.bin")
                .to_str()
                .context("model path")?,
            params,
        )?)
    } else {
        None
    };
    let parakeet = if args[0] == "parakeet" {
        Some(
            ParakeetEngine::load(&models.join(transcribe::PARAKEET_V3_ID))
                .map_err(|e| anyhow!(e))?,
        )
    } else {
        None
    };
    let load_seconds = load_started.elapsed().as_secs_f64();
    let warmup_started = Instant::now();
    if let Some(ctx) = &whisper {
        linty_lib::warm_up_whisper(ctx).map_err(|e| anyhow!(e))?;
    }
    emit(
        &mut file,
        json!({"type":"ready", "model_load_seconds":load_seconds,
        "explicit_warmup_seconds":warmup_started.elapsed().as_secs_f64(),
        "explicit_warmup":if whisper.is_some() {"production Whisper warmup"} else {"none; preparation occurs in model load"}}),
    )?;
    let mut errors = 0;
    for (index, case) in manifest.cases.iter().enumerate() {
        let audio = read_audio(base, case);
        let (text, error, seconds, audio_seconds) = match audio {
            Err(error) => (String::new(), Some(format!("audio: {error}")), None, None),
            Ok(samples) => {
                let start = Instant::now();
                let result = if let Some(ctx) = &whisper {
                    transcribe::transcribe_local(ctx, &samples, None, Some("en"), |_| {}, |_| {})
                } else {
                    transcribe::transcribe_parakeet(
                        parakeet.as_ref().unwrap(),
                        &samples,
                        Some("en"),
                    )
                };
                let seconds = start.elapsed().as_secs_f64();
                let (text, error) = match result {
                    Ok(text) => (text, None),
                    Err(error) => (String::new(), Some(format!("transcription: {error}"))),
                };
                (
                    text,
                    error,
                    Some(seconds),
                    Some(samples.len() as f64 / 16000.0),
                )
            }
        };
        if error.is_some() {
            errors += 1;
        }
        emit(
            &mut file,
            json!({"type":"case", "id":case.id, "audio_sha256":case.audio_sha256,
            "text":text, "error":error, "inference_seconds":seconds, "audio_seconds":audio_seconds,
            "sequence":index, "first_inference":index == 0}),
        )?;
        if (index + 1) % 25 == 0 || index + 1 == manifest.cases.len() {
            eprintln!(
                "{}: {}/{} clips, {} errors",
                args[0],
                index + 1,
                manifest.cases.len(),
                errors
            );
        }
    }
    emit(
        &mut file,
        json!({"type":"complete", "cases":manifest.cases.len(), "errors":errors}),
    )?;
    Ok(())
}
