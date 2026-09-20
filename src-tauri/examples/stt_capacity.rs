//! Isolated, machine-readable capacity benchmark using the app's STT functions.
//! One model and one WAV per process: memory peaks cannot leak between cases.
//! Run: stt_capacity <whisper|parakeet> <models-dir> <16k-mono.wav> <output-dir> [runs]
//! Audio and models must already exist. Nothing is downloaded or recorded.

use linty_lib::{parakeet::ParakeetEngine, transcribe};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, time::Instant};

struct Usage(libc::rusage);

impl Usage {
    fn now() -> Self {
        let mut value = std::mem::MaybeUninit::<libc::rusage>::uninit();
        // SAFETY: getrusage initializes the complete struct on success.
        let status = unsafe { libc::getrusage(libc::RUSAGE_SELF, value.as_mut_ptr()) };
        assert_eq!(status, 0, "getrusage failed");
        Self(unsafe { value.assume_init() })
    }

    fn cpu_seconds(&self) -> f64 {
        let time = |v: libc::timeval| v.tv_sec as f64 + v.tv_usec as f64 / 1_000_000.0;
        time(self.0.ru_utime) + time(self.0.ru_stime)
    }

    fn peak_rss_bytes(&self) -> i64 {
        // Darwin reports bytes; Linux reports KiB.
        if cfg!(target_os = "macos") {
            self.0.ru_maxrss
        } else {
            self.0.ru_maxrss * 1024
        }
    }
}

enum Engine {
    Whisper(whisper_rs::WhisperContext),
    Parakeet(ParakeetEngine),
}

#[cfg(target_os = "macos")]
fn physical_memory() -> Option<Value> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::uninit();
    // SAFETY: the v4 flavor writes the matching rusage_info_v4 buffer. Inspect
    // the initialized fields only after the operating system returns success.
    let status = unsafe {
        libc::proc_pid_rusage(
            std::process::id() as libc::c_int,
            libc::RUSAGE_INFO_V4,
            info.as_mut_ptr().cast(),
        )
    };
    if status != 0 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some(json!({
        "physical_footprint_bytes":info.ri_phys_footprint,
        "peak_physical_footprint_bytes":info.ri_lifetime_max_phys_footprint,
        "resident_bytes":info.ri_resident_size,
        "disk_read_bytes":info.ri_diskio_bytesread,
        "disk_written_bytes":info.ri_diskio_byteswritten,
        "instructions":info.ri_instructions,
        "cycles":info.ri_cycles,
    }))
}

#[cfg(not(target_os = "macos"))]
fn physical_memory() -> Option<Value> {
    None
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 4 || args.len() > 5 {
        return Err(
            "usage: stt_capacity <whisper|parakeet> <models-dir> <wav> <output-dir> [runs]".into(),
        );
    }
    let kind = &args[0];
    if kind != "whisper" && kind != "parakeet" {
        return Err("unknown engine".into());
    }
    let models = PathBuf::from(&args[1]);
    let wav = PathBuf::from(&args[2]);
    let output = PathBuf::from(&args[3]);
    let runs: usize = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(2);
    if runs == 0 {
        return Err("runs must be positive".into());
    }
    fs::create_dir_all(&output)?;
    let process_start = Instant::now();
    let initial = Usage::now();
    println!(
        "CAPACITY {}",
        json!({"event":"start", "pid":std::process::id(), "engine":kind})
    );

    let read_start = Instant::now();
    let mut reader = hound::WavReader::open(&wav)?;
    let spec = reader.spec();
    if spec.sample_rate != 16000
        || spec.channels != 1
        || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int
    {
        return Err("input must be 16 kHz mono 16-bit PCM WAV".into());
    }
    // Reserve exactly once, so WAV decoding does not inflate the input allocation.
    let mut samples = Vec::with_capacity(reader.len() as usize);
    for sample in reader.samples::<i16>() {
        samples.push(sample? as f32 / 32768.0);
    }
    let read_seconds = read_start.elapsed().as_secs_f64();
    let duration = samples.len() as f64 / 16000.0;
    println!(
        "CAPACITY {}",
        json!({"event":"audio_loaded", "audio_seconds":duration})
    );

    let load_start = Instant::now();
    let engine = match kind.as_str() {
        "whisper" => {
            let path = models.join("ggml-large-v3-turbo-q5_0.bin");
            let mut parameters = whisper_rs::WhisperContextParameters::default();
            parameters.use_gpu(cfg!(target_arch = "aarch64"));
            Engine::Whisper(whisper_rs::WhisperContext::new_with_params(
                path.to_str().ok_or("invalid model path")?,
                parameters,
            )?)
        }
        _ => Engine::Parakeet(ParakeetEngine::load(
            &models.join(transcribe::PARAKEET_V3_ID),
        )?),
    };
    let load_seconds = load_start.elapsed().as_secs_f64();
    let mut results: Vec<Value> = Vec::new();
    let mut failed = false;
    for run in 1..=runs {
        println!("CAPACITY {}", json!({"event":"inference_start", "run":run}));
        let before = Usage::now();
        let start = Instant::now();
        let result = match &engine {
            Engine::Whisper(ctx) => {
                transcribe::transcribe_local(ctx, &samples, None, Some("en"), |_| {}, |_| {})
            }
            Engine::Parakeet(engine) => {
                transcribe::transcribe_parakeet(engine, &samples, Some("en"))
            }
        };
        let seconds = start.elapsed().as_secs_f64();
        let after = Usage::now();
        let cpu_seconds = after.cpu_seconds() - before.cpu_seconds();
        let (text, error) = match result {
            Ok(text) => (text, None),
            Err(error) => {
                failed = true;
                (String::new(), Some(error))
            }
        };
        let file = format!("transcript-{run}.txt");
        fs::write(output.join(&file), &text)?;
        let value = json!({
            "run":run, "inference_seconds":seconds, "cpu_seconds":cpu_seconds,
            "average_cpu_percent":100.0 * cpu_seconds / seconds,
            "real_time_factor":seconds / duration, "audio_speedup":duration / seconds,
            "process_peak_rss_bytes":after.peak_rss_bytes(),
            "memory":physical_memory(),
            "page_ins":after.0.ru_majflt - before.0.ru_majflt,
            "voluntary_context_switches":after.0.ru_nvcsw - before.0.ru_nvcsw,
            "involuntary_context_switches":after.0.ru_nivcsw - before.0.ru_nivcsw,
            "word_count":text.split_whitespace().count(), "transcript_file":file, "error":error,
        });
        println!(
            "CAPACITY {}",
            json!({"event":"inference_complete", "result":value})
        );
        results.push(value);
    }
    let final_usage = Usage::now();
    let report = json!({
        "engine":kind, "audio_file":wav, "audio_seconds":duration,
        "input_f32_bytes":samples.len() * 4, "wav_read_seconds":read_seconds,
        "model_load_seconds":load_seconds, "runs":results,
        "process_wall_seconds":process_start.elapsed().as_secs_f64(),
        "process_cpu_seconds":final_usage.cpu_seconds() - initial.cpu_seconds(),
        "process_peak_rss_bytes":final_usage.peak_rss_bytes(),
        "memory":physical_memory(),
        "build_profile":if cfg!(debug_assertions) {"debug"} else {"release"},
    });
    fs::write(
        output.join("metrics.json"),
        serde_json::to_string_pretty(&report)?,
    )?;
    if failed {
        return Err("one or more inferences failed; see metrics.json".into());
    }
    Ok(())
}
