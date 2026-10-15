//! An independent, bounded main-run-loop probe. It never waits for AppState
//! locks or queues more than one callback while the UI is stalled.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::Manager;

const TICK: Duration = Duration::from_secs(2);
const STALL: Duration = Duration::from_secs(6);
#[cfg(feature = "capsule-recovery-test")]
static REHEARSAL_STALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(feature = "capsule-recovery-test")]
static REHEARSAL_RECOVERIES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(feature = "capsule-recovery-test")]
pub fn rehearsal_health() -> (u64, u64) {
    (
        REHEARSAL_STALLS.load(Ordering::Relaxed),
        REHEARSAL_RECOVERIES.load(Ordering::Relaxed),
    )
}

#[derive(Default)]
struct Probe {
    pending_since: Option<Instant>,
    reported: bool,
    stalls: u64,
    max_latency_ms: u128,
}

impl Probe {
    fn completed(&mut self, now: Instant) -> Option<u128> {
        let elapsed = now.saturating_duration_since(self.pending_since.take()?);
        self.max_latency_ms = self.max_latency_ms.max(elapsed.as_millis());
        self.reported.then(|| {
            self.reported = false;
            elapsed.as_millis()
        })
    }
    fn stalled(&mut self, now: Instant) -> bool {
        if self.reported
            || !self
                .pending_since
                .is_some_and(|s| now.saturating_duration_since(s) >= STALL)
        {
            return false;
        }
        self.reported = true;
        self.stalls += 1;
        true
    }
}

pub fn start(app: tauri::AppHandle) {
    let diagnostics = app
        .path()
        .app_log_dir()
        .ok()
        .map(|p| p.join("hang-diagnostics"));
    if let Err(error) = std::thread::Builder::new().name("main-loop-health".into()).spawn(move || {
        let ready = Arc::new(AtomicBool::new(true));
        let mut probe = Probe::default();
        let mut previous_tick = Instant::now();
        let mut ticks = 0u64;
        let mut last_sample: Option<Instant> = None;
        loop {
            std::thread::sleep(TICK);
            let now = Instant::now();
            // Suspension/debugger/whole-process scheduling gaps are not evidence
            // of a main-thread stall. Give an outstanding callback a fresh window.
            if now.saturating_duration_since(previous_tick) > STALL {
                probe.pending_since = probe.pending_since.map(|_| now);
                probe.reported = false;
            }
            previous_tick = now;
            if ready.swap(false, Ordering::AcqRel) {
                if let Some(ms) = probe.completed(now) {
                    #[cfg(feature = "capsule-recovery-test")]
                    REHEARSAL_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                    log::warn!("[responsiveness] main thread recovered; probe_latency_ms={ms} stalls={}", probe.stalls);
                }
                let ack = ready.clone();
                probe.pending_since = Some(now);
                if app.run_on_main_thread(move || { ack.store(true, Ordering::Release); }).is_err() {
                    log::warn!("[responsiveness] main-thread dispatch unavailable");
                    break;
                }
            } else if probe.stalled(now) {
                #[cfg(feature = "capsule-recovery-test")]
                REHEARSAL_STALLS.fetch_add(1, Ordering::Relaxed);
                log::error!("[responsiveness] main thread has not acknowledged a probe for >=6s; stalls={}; audio and trigger repair are not proof of run-loop health", probe.stalls);
                if last_sample.is_none_or(|last| now.saturating_duration_since(last) >= Duration::from_secs(600)) {
                    if let Some(dir) = diagnostics.as_ref() {
                        capture_stacks(dir.clone(), (probe.stalls % 3) as usize);
                        last_sample = Some(now);
                    }
                }
            }
            ticks += 1;
            if ticks % 30 == 0 {
                #[cfg(target_os = "macos")]
                {
                    let (global, local, global_events, local_events) = crate::fnkey::health();
                    log::info!("[reliability] main_probe_pending={} stalls={} max_probe_latency_ms={} global_installed={} local_installed={} global_events={} local_events={}", !ready.load(Ordering::Acquire), probe.stalls, probe.max_latency_ms, global, local, global_events, local_events);
                }
            }
        }
    }) {
        log::error!("[responsiveness] health thread could not start: {error}");
    }
}

/// Stack symbols only, kept on this Mac; never memory, transcripts or audio.
/// Three capped files, at most one sample per ten minutes. A separate thread
/// and a child timeout keep diagnostics from blocking the health monitor.
#[cfg(target_os = "macos")]
fn capture_stacks(dir: std::path::PathBuf, slot: usize) {
    let _ = std::thread::Builder::new()
        .name("hang-stack-sample".into())
        .spawn(move || {
            use std::io::{Read, Write};
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            use std::process::{Command, Stdio};
            let partial = dir.join("sample.partial");
            let work = || -> std::io::Result<()> {
                std::fs::create_dir_all(&dir)?;
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
                let file = std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(&partial)?;
                drop(file);
                let mut child = Command::new("/usr/bin/sample")
                    .args([std::process::id().to_string(), "1".into(), "10".into()])
                    .arg("-file")
                    .arg(&partial)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()?;
                let start = Instant::now();
                let success = loop {
                    if let Some(status) = child.try_wait()? {
                        break status.success();
                    }
                    if start.elapsed() >= Duration::from_secs(5) {
                        let _ = child.kill();
                        let _ = child.wait();
                        break false;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                };
                if success {
                    let mut bytes = Vec::new();
                    std::fs::File::open(&partial)?
                        .take(2 * 1024 * 1024)
                        .read_to_end(&mut bytes)?;
                    let raw = String::from_utf8_lossy(&bytes);
                    let redacted = match std::env::var("HOME") {
                        Ok(home) if !home.is_empty() => raw.replace(&home, "~"),
                        _ => raw.into_owned(),
                    };
                    let path = dir.join(format!("main-thread-{slot}.sample.txt"));
                    let mut output = std::fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(true)
                        .mode(0o600)
                        .open(path)?;
                    output.write_all(redacted.as_bytes())?;
                    log::info!("[responsiveness] saved local stack sample; slot={slot}");
                }
                Ok(())
            };
            if work().is_err() {
                log::warn!("[responsiveness] local stack sample unavailable");
            }
            let _ = std::fs::remove_file(partial);
        });
}
#[cfg(not(target_os = "macos"))]
fn capture_stacks(_dir: std::path::PathBuf, _slot: usize) {}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_once_and_records_recovery_without_queuing_more_probes() {
        let start = Instant::now();
        let mut p = Probe {
            pending_since: Some(start),
            ..Probe::default()
        };
        assert!(!p.stalled(start + Duration::from_secs(5)));
        assert!(p.stalled(start + STALL));
        assert!(!p.stalled(start + STALL * 10));
        assert_eq!(p.stalls, 1);
        assert_eq!(p.completed(start + Duration::from_secs(9)), Some(9000));
        assert_eq!(p.max_latency_ms, 9000);
        assert!(p.pending_since.is_none());
        assert!(!p.reported);
    }
    #[test]
    fn healthy_probe_does_not_report_a_hang() {
        let start = Instant::now();
        let mut p = Probe {
            pending_since: Some(start),
            ..Probe::default()
        };
        assert_eq!(p.completed(start + TICK), None);
        assert!(!p.stalled(start + STALL));
        assert_eq!(p.stalls, 0);
    }
}
