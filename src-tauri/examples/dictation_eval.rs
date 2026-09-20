//! Offline evaluation of text cleanup or recorded WAV -> Parakeet -> S1.
//! dictation_eval MODELS_DIR CORPUS.json REPORT.json [AUDIO_DIR]
//! Audio mode reads CASE_ID.wav; missing files stay pending, never become text tests.
//! No downloads, recording, app settings changes, history writes, or clipboard access.
use linty_lib::{parakeet::ParakeetEngine, reformat, sha256_hex, transcribe};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, path::Path, time::Instant};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    schema_version: u8,
    language: String,
    options: reformat::Options,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    input: String,
}

fn read_wav(path: &Path) -> anyhow::Result<(Vec<f32>, String)> {
    let bytes = fs::read(path)?;
    let digest = sha256_hex(Sha256::digest(&bytes));
    let mut reader = hound::WavReader::new(std::io::Cursor::new(bytes))?;
    let spec = reader.spec();
    anyhow::ensure!(
        spec.channels == 1
            && spec.sample_rate == 16000
            && spec.bits_per_sample == 16
            && spec.sample_format == hound::SampleFormat::Int,
        "WAV must be 16 kHz mono 16-bit PCM"
    );
    let samples = reader
        .samples::<i16>()
        .map(|s| s.map(|n| n as f32 / 32768.0))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((samples, digest))
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(
        (3..=4).contains(&args.len()),
        "usage: dictation_eval MODELS_DIR CORPUS.json REPORT.json [AUDIO_DIR]"
    );
    let models = Path::new(&args[0]);
    let corpus_bytes = fs::read(&args[1])?;
    let corpus: Corpus = serde_json::from_slice(&corpus_bytes)?;
    anyhow::ensure!(corpus.schema_version == 1, "Unsupported corpus schema");
    let mut ids = HashSet::new();
    for case in &corpus.cases {
        anyhow::ensure!(
            !case.id.is_empty()
                && case
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && ids.insert(case.id.clone()),
            "Case IDs must be unique filename-safe identifiers"
        );
    }
    let audio_dir = args.get(3).map(Path::new);
    if let Some(dir) = audio_dir {
        anyhow::ensure!(dir.is_dir(), "Audio directory does not exist");
    }
    let parakeet = if audio_dir.is_some() {
        let dir = models.join(transcribe::PARAKEET_V3_ID);
        anyhow::ensure!(
            linty_lib::parakeet::models_exist(&dir),
            "Parakeet must already be installed"
        );
        let started = Instant::now();
        let engine = ParakeetEngine::load(&dir).map_err(anyhow::Error::msg)?;
        Some((engine, started.elapsed().as_secs_f64() * 1000.))
    } else {
        None
    };
    let model_dir = models.join("s1-mini");
    let mut cleanup = None;
    let started = Instant::now();
    reformat::prepare(&mut cleanup, &model_dir, || false)?;
    let preparation_ms = started.elapsed().as_secs_f64() * 1000.;
    let mut results = Vec::new();
    for case in corpus.cases {
        eprintln!("Evaluating {}", case.id);
        let mut row = json!({ "id": case.id });
        let raw_text = if let Some(dir) = audio_dir {
            let wav = dir.join(format!("{}.wav", case.id));
            if !wav.try_exists()? {
                row["outcome"] = json!("pending-audio");
                results.push(row);
                continue;
            }
            let (samples, digest) = match read_wav(&wav) {
                Ok(data) => data,
                Err(error) => {
                    row["outcome"] = json!("audio-error");
                    row["error"] = json!(error.to_string());
                    results.push(row);
                    continue;
                }
            };
            row["audioSha256"] = json!(digest);
            row["audioDurationSeconds"] = json!(samples.len() as f64 / 16000.);
            let started = Instant::now();
            let result = transcribe::transcribe_parakeet(
                &parakeet.as_ref().unwrap().0,
                &samples,
                Some(&corpus.language),
            );
            row["sttTimeMs"] = json!(started.elapsed().as_secs_f64() * 1000.);
            match result {
                Ok(text) => text,
                Err(error) => {
                    row["outcome"] = json!("stt-error");
                    row["error"] = json!(error);
                    results.push(row);
                    continue;
                }
            }
        } else {
            case.input
        };
        row["rawText"] = json!(raw_text);
        // Match the application's no-speech path: do not run cleanup on empty STT.
        if raw_text.trim().is_empty() {
            row["outcome"] = json!("no-speech");
            row["text"] = json!("");
        } else {
            let result = reformat::run(
                &mut cleanup,
                &model_dir,
                &raw_text,
                &corpus.language,
                corpus.options.clone(),
                || false,
            );
            row["outcome"] = json!("completed");
            row["text"] = json!(result.text);
            row["metrics"] = serde_json::to_value(result.metrics)?;
        }
        results.push(row);
    }
    let report = json!({
        "schemaVersion": 1,
        "corpusSha256": sha256_hex(Sha256::digest(&corpus_bytes)),
        "source": if audio_dir.is_some() { "audio" } else { "text" },
        "runtime": "linty-candle",
        "language": corpus.language,
        "options": corpus.options,
        "speechModelId": parakeet.as_ref().map(|_| transcribe::PARAKEET_V3_ID),
        "speechPreparationMs": parakeet.as_ref().map(|(_, ms)| ms),
        "cleanupPreparationMs": preparation_ms,
        "dictionaryEnabled": false,
        "results": results,
    });
    let output = Path::new(&args[2]);
    if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    fs::write(output, serde_json::to_vec_pretty(&report)?)?;
    eprintln!(
        "Saved {} cases to {}",
        report["results"].as_array().unwrap().len(),
        output.display()
    );
    Ok(())
}
