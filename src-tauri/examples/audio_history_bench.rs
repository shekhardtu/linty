//! Synthetic audio storage benchmark. No microphone, model, network or real history.
#![allow(dead_code)]
#[path = "../src/history_db.rs"]
mod history_db;
#[path = "../src/pcm_wav.rs"]
mod pcm_wav;
#[cfg(test)]
use linty_lib::transcribe;

use history_db::{HistoryDb, PendingAudio, AUDIO_READ_LIMIT};
use serde_json::json;
use std::{fs, path::PathBuf, sync::Arc, time::Instant};

struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn usage() -> (f64, i64) {
    let mut value = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: a successful getrusage initializes the entire output struct.
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, value.as_mut_ptr()) },
        0
    );
    let value = unsafe { value.assume_init() };
    let cpu = value.ru_utime.tv_sec as f64
        + value.ru_utime.tv_usec as f64 / 1e6
        + value.ru_stime.tv_sec as f64
        + value.ru_stime.tv_usec as f64 / 1e6;
    #[cfg(target_os = "macos")]
    let rss = value.ru_maxrss;
    #[cfg(not(target_os = "macos"))]
    let rss = value.ru_maxrss * 1024;
    (cpu, rss)
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let seconds = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "1800".into())
        .parse::<usize>()?;
    assert!(
        (1..=3600).contains(&seconds),
        "Use a duration from 1 to 3600 seconds"
    );
    let temp = Temp(std::env::temp_dir().join(format!("linty-audio-bench-{}", std::process::id())));
    fs::create_dir(&temp.0)?;
    let mut db = HistoryDb::open(&temp.0)?;
    db.set_save_audio(true, 1)?;
    let consent_epoch = db.audio_consent()?.unwrap();
    let raw = vec![0.125_f32; seconds * 16000];
    let source_pointer = raw.as_ptr();
    let started = Instant::now();
    let samples = Arc::new(raw);
    let pending = PendingAudio {
        generation: 1,
        consent_epoch,
        samples: Arc::clone(&samples),
    };
    let handoff_us = started.elapsed().as_secs_f64() * 1e6;
    assert_eq!(pending.samples.as_ptr(), source_pointer);
    let raw_bytes = samples.len() * 4;
    let wav_bytes = pcm_wav::encoded_len(samples.len())? as usize;
    drop(samples);
    let before = usage();
    let start = Instant::now();
    db.save_with_audio(&json!({"transcriptId":"bench","timestamp":2,"finalText":"Synthetic benchmark","rawText":"Synthetic benchmark"}), 2, Some(&pending))?;
    let save_ms = start.elapsed().as_secs_f64() * 1000.;
    let after_save = usage();
    drop(pending);
    let start = Instant::now();
    let mut received = 0;
    while received < wav_bytes {
        received += db
            .audio_chunk("bench", received as u64, AUDIO_READ_LIMIT)?
            .len();
    }
    let read_ms = start.elapsed().as_secs_f64() * 1000.;
    let start = Instant::now();
    let mut export = fs::File::create(temp.0.join("synthetic.wav"))?;
    assert_eq!(db.copy_audio("bench", &mut export)?, wav_bytes as u64);
    export.sync_all()?;
    let export_ms = start.elapsed().as_secs_f64() * 1000.;
    let start = Instant::now();
    db.delete_audio(None)?;
    let delete_ms = start.elapsed().as_secs_f64() * 1000.;
    assert_eq!(db.snapshot()?["audioBytes"], 0);
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "audioSeconds":seconds,"sharedCaptureBytes":raw_bytes,"savedWavBytes":wav_bytes,
            "captureHandoffMicroseconds":handoff_us,"encodingScratchBytes":pcm_wav::ENCODE_BUFFER_BYTES,
            "saveWallMs":save_ms,"saveCpuMs":(after_save.0-before.0)*1000.,
            "peakRssBeforeSaveBytes":before.1,"peakRssAfterSaveBytes":after_save.1,
            "readAllChunksMs":read_ms,"maxReadChunkBytes":AUDIO_READ_LIMIT,
            "exportWallMs":export_ms,"deleteWallMs":delete_ms,
            "modelCalls":0,"microphoneUsed":false,"networkUsed":false,
        }))?
    );
    Ok(())
}
