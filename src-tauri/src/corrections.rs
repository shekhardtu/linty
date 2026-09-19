//! Native correction capture: one retained field, one editing session, one final
//! batch. Unsupported or uncertain captures are discarded without prompting.
pub(crate) mod accessibility;
mod diff;
mod session;

use accessibility::{InputMonitor, Observer, Target};
use serde::Serialize;
use session::{EditingSession, InputState, Outcome, Snapshot};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

const POLL: Duration = Duration::from_millis(120);
static SENDER: OnceLock<mpsc::Sender<Command>> = OnceLock::new();
static NEXT_PASTE: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObservedApplication {
    pub name: String,
    pub bundle_id: Option<String>,
}
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ObservedPair {
    pub kind: &'static str,
    pub from: String,
    pub to: String,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ObservedCorrection {
    pub transcript_id: String,
    pub word_count: usize,
    pub application: ObservedApplication,
    pub pairs: Vec<ObservedPair>,
    pub seconds_after_paste: u64,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ObservedBatch {
    batch_id: String,
    corrections: Vec<ObservedCorrection>,
}

enum Command {
    Begin(u64, Option<Target>, mpsc::SyncSender<()>),
    Pasted(u64, Option<(String, String)>),
    Stop,
}

pub fn start(app: tauri::AppHandle) {
    let (send, receive) = mpsc::channel();
    if SENDER.set(send).is_err() {
        return;
    }
    if let Err(error) = std::thread::Builder::new()
        .name("correction-session".into())
        .spawn(move || run(app, receive))
    {
        log::warn!("[corrections] controller unavailable: {error}");
    }
}

/// Pause observation BEFORE posting Cmd+V. The controller never interprets
/// Linty's next insertion as a user correction, even when AX reads are slow.
pub(crate) fn prepare_target(target: Option<Target>) -> Option<u64> {
    let id = NEXT_PASTE.fetch_add(1, Ordering::Relaxed);
    let (send, receive) = mpsc::sync_channel(1);
    SENDER.get()?.send(Command::Begin(id, target, send)).ok()?;
    if receive.recv_timeout(Duration::from_secs(2)).is_err() {
        stop();
        return None;
    }
    Some(id)
}
pub fn complete_paste(id: Option<u64>, insertion: Option<(String, String)>) {
    if let (Some(send), Some(id)) = (SENDER.get(), id) {
        let _ = send.send(Command::Pasted(id, insertion));
    }
}
pub fn stop() {
    if let Some(send) = SENDER.get() {
        let _ = send.send(Command::Stop);
    }
}

struct Active {
    target: Target,
    observer: Option<Observer>,
    input: Option<InputMonitor>,
    session: EditingSession,
}
impl Active {
    fn input(&self) -> InputState {
        self.input
            .as_ref()
            .map(InputMonitor::snapshot)
            .unwrap_or_default()
    }
    fn wait(&self) {
        if let Some(observer) = &self.observer {
            observer.wait();
        } else {
            std::thread::sleep(POLL);
        }
    }
    fn sample(&mut self) -> Outcome {
        let focused = self.target.is_focused();
        let composing = self.target.is_composing();
        let before = self.input();
        let read_started = Instant::now();
        let value = if composing { None } else { self.target.read() };
        // NSEvent delivery is asynchronous. Settle queued input before deciding
        // whether a changed value is editing or the host's response to Return.
        if value
            .as_ref()
            .is_some_and(|v| v != &self.session.pending.latest)
        {
            std::thread::sleep(POLL);
        }
        let after = self.input();
        self.session.observe(Snapshot {
            value,
            focused,
            composing,
            before,
            after,
            read_started,
            now: Instant::now(),
            can_submit: self.input.is_some(),
        })
    }
}

fn emit(app: &tauri::AppHandle, active: Active) {
    let corrections = active.session.finish(active.target.application.clone());
    if corrections.is_empty() {
        return;
    }
    log::info!(
        "[corrections] verified editing session: {} dictation(s)",
        corrections.len()
    );
    let batch_id = format!(
        "native-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT_PASTE.fetch_add(1, Ordering::Relaxed)
    );
    if let Err(error) = app.emit(
        "correction-observed",
        ObservedBatch {
            batch_id,
            corrections,
        },
    ) {
        log::warn!("[corrections] could not report saved candidate batch: {error}");
    }
}

fn run(app: tauri::AppHandle, receive: mpsc::Receiver<Command>) {
    let mut active: Option<Active> = None;
    let mut preparing: Option<(u64, Option<Target>, Instant)> = None;
    let mut queued = None;
    loop {
        let command = if queued.is_some() {
            queued.take()
        } else if active.is_some() && preparing.is_none() {
            match receive.try_recv() {
                Ok(command) => Some(command),
                Err(mpsc::TryRecvError::Disconnected) => break,
                Err(mpsc::TryRecvError::Empty) => None,
            }
        } else {
            match receive.recv_timeout(POLL) {
                Ok(command) => Some(command),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => None,
            }
        };
        match command {
            Some(Command::Stop) => {
                active = None;
                preparing = None;
            }
            Some(Command::Begin(id, target, reply)) => {
                let same = active
                    .as_ref()
                    .zip(target.as_ref())
                    .is_some_and(|(a, t)| a.target.same_field(t));
                if !same {
                    // A different field is a boundary only when the retained
                    // field is readable and a settled focus departure is proven.
                    if let Some(mut old) = active.take() {
                        if old.sample() == Outcome::Finish {
                            emit(&app, old);
                        }
                    }
                }
                preparing = Some((id, target, Instant::now()));
                let _ = reply.send(());
            }
            Some(Command::Pasted(id, insertion)) => {
                if preparing.as_ref().is_none_or(|p| p.0 != id) {
                    continue;
                }
                let (_, target, _) = preparing.take().unwrap();
                let Some((target, (transcript_id, pasted))) = target.zip(insertion) else {
                    active = None;
                    continue;
                };
                // Target includes the bounded pre-paste text and UTF-16 selection.
                let mut attached = false;
                for _ in 0..8 {
                    std::thread::sleep(POLL);
                    if target.is_focused() != Some(true) || target.is_composing() {
                        break;
                    }
                    let Some(value) = target.read() else {
                        continue;
                    };
                    if active.is_none() {
                        let Some(input) = InputMonitor::new(&app, target.pid) else {
                            break;
                        };
                        active = Some(Active {
                            observer: Observer::new(&target),
                            input: Some(input),
                            target: target.retained(),
                            session: EditingSession::new(value.clone()),
                        });
                    }
                    let session = &mut active.as_mut().unwrap().session;
                    if session.insert(
                        transcript_id.clone(),
                        pasted.clone(),
                        &target.before,
                        target.selection.clone(),
                        value,
                    ) {
                        attached = true;
                        break;
                    }
                }
                if !attached {
                    log::info!(
                        "[corrections] capture unavailable: insertion could not be verified"
                    );
                    active = None;
                }
            }
            None if preparing.is_some() => {
                if preparing
                    .as_ref()
                    .is_some_and(|p| p.2.elapsed() >= Duration::from_secs(5))
                {
                    preparing = None;
                    active = None;
                }
            }
            None => {
                if let Some(current) = &mut active {
                    current.wait();
                    // Process queued paste/stop before reading another value.
                    if let Ok(command) = receive.try_recv() {
                        queued = Some(command);
                        continue;
                    }
                    match current.sample() {
                        Outcome::Continue => {}
                        Outcome::Finish => {
                            emit(&app, active.take().unwrap());
                        }
                        Outcome::Discard => {
                            active = None;
                        }
                    }
                }
            }
        }
    }
}
