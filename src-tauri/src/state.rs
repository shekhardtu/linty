use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{mpsc, Arc, Mutex};

/// Default idle time before the local speech model is unloaded (15 minutes).
#[cfg(feature = "local-stt")]
pub const DEFAULT_MODEL_IDLE_UNLOAD_SECS: u64 = 15 * 60;

#[derive(Default)]
pub struct RecordingState {
    pub is_recording: bool,
    /// Shared by inference and optional history storage without copying samples.
    pub samples: Arc<Vec<f32>>,
    pub application: Option<crate::application::ApplicationIdentity>,
    pub audio_consent: Option<i64>,
    pub history_audio: Option<crate::history_db::PendingAudio>,
}

impl RecordingState {
    pub fn take_history_audio(
        &mut self,
        generation: u64,
    ) -> Option<crate::history_db::PendingAudio> {
        if self
            .history_audio
            .as_ref()
            .is_some_and(|a| a.generation == generation)
        {
            self.history_audio.take()
        } else {
            None
        }
    }
}

#[cfg(test)]
mod audio_history_tests {
    use super::*;

    #[test]
    fn stale_save_or_cleanup_cannot_consume_another_recording() {
        let mut rec = RecordingState {
            history_audio: Some(crate::history_db::PendingAudio {
                generation: 12,
                consent_epoch: 3,
                samples: Arc::new(vec![0.1, 0.2, 0.3]),
            }),
            ..Default::default()
        };
        assert!(rec.take_history_audio(11).is_none());
        assert!(rec.take_history_audio(13).is_none());
        assert_eq!(
            *rec.take_history_audio(12).unwrap().samples,
            vec![0.1, 0.2, 0.3]
        );
        assert!(
            rec.take_history_audio(12).is_none(),
            "A recording attaches only once"
        );
    }

    #[test]
    fn inference_and_history_share_one_sample_allocation_and_release_it() {
        let samples = Arc::new(vec![0.25; 16000]);
        let weak = Arc::downgrade(&samples);
        let pointer = samples.as_ptr();
        let mut rec = RecordingState {
            samples: Arc::clone(&samples),
            history_audio: Some(crate::history_db::PendingAudio {
                generation: 1,
                consent_epoch: 1,
                samples: Arc::clone(&samples),
            }),
            ..Default::default()
        };
        drop(samples);
        let inference = std::mem::take(&mut rec.samples);
        assert_eq!(inference.as_ptr(), pointer);
        assert_eq!(
            rec.history_audio.as_ref().unwrap().samples.as_ptr(),
            pointer
        );
        drop(inference);
        drop(rec.take_history_audio(1));
        assert!(
            weak.upgrade().is_none(),
            "Completing/cancelling releases the shared capture"
        );
    }
}

/// Commands sent to the dedicated audio thread.
pub enum AudioCommand {
    Start {
        input_name: Option<String>,
        generation: u64,
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    Stop,
}

pub struct AppState {
    pub recording: Mutex<RecordingState>,
    /// Shared buffer that the audio callback writes into.
    pub audio_buffer: Arc<Mutex<Vec<f32>>>,
    /// Channel to send commands to the audio thread.
    pub audio_tx: Mutex<Option<mpsc::Sender<AudioCommand>>>,
    /// whisper-rs context for local STT (loaded once, reused).
    /// Wrapped in Arc so we can clone it out of the mutex before blocking inference.
    #[cfg(feature = "local-stt")]
    pub whisper_ctx: Mutex<Option<Arc<whisper_rs::WhisperContext>>>,
    /// Parakeet TDT engine on the Neural Engine. Only one local engine is
    /// resident at a time: loading one drops the other.
    #[cfg(feature = "parakeet")]
    pub parakeet_engine: Mutex<Option<Arc<crate::parakeet::ParakeetEngine>>>,
    /// Filename (whisper .bin) or bundle id (parakeet dir) of the selected local
    /// model — lets transcribe_buffer transparently reload after the watchdog's
    /// idle unload.
    #[cfg(feature = "local-stt")]
    pub local_model_filename: Mutex<Option<String>>,
    /// Epoch millis of last local-model use (load/recording/transcription), 0 = never.
    /// Read by the watchdog to unload the model after idle.
    #[cfg(feature = "local-stt")]
    pub local_model_last_used_at: AtomicU64,
    /// Seconds of inactivity after which the model is unloaded (0 = never).
    /// Configurable from Settings; synced via set_model_idle_unload_minutes.
    #[cfg(feature = "local-stt")]
    pub model_idle_unload_secs: AtomicU64,
    /// Serializes model loads — prevents a lazy reload racing an explicit load
    /// and transiently holding two models in memory. tokio Mutex: held across await.
    #[cfg(feature = "local-stt")]
    pub local_model_load_lock: tokio::sync::Mutex<()>,
    /// App icons already rendered for the UI, keyed by bundle id (None = no icon).
    /// Icons are a few KB each and only apps the user dictated into are ever asked for.
    pub app_icon_cache: Mutex<HashMap<String, Option<String>>>,
    /// Incremented by audio callback, read+reset by watchdog to detect runaway callbacks.
    pub audio_callback_count: Arc<AtomicU64>,
    /// Invalidates callbacks and pending startup from an abandoned recording.
    pub audio_generation: Arc<AtomicU64>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            recording: Mutex::new(RecordingState::default()),
            audio_buffer: Arc::new(Mutex::new(Vec::new())),
            audio_tx: Mutex::new(None),
            #[cfg(feature = "local-stt")]
            whisper_ctx: Mutex::new(None),
            #[cfg(feature = "parakeet")]
            parakeet_engine: Mutex::new(None),
            #[cfg(feature = "local-stt")]
            local_model_filename: Mutex::new(None),
            #[cfg(feature = "local-stt")]
            local_model_last_used_at: AtomicU64::new(0),
            #[cfg(feature = "local-stt")]
            model_idle_unload_secs: AtomicU64::new(DEFAULT_MODEL_IDLE_UNLOAD_SECS),
            #[cfg(feature = "local-stt")]
            local_model_load_lock: tokio::sync::Mutex::new(()),
            app_icon_cache: Mutex::new(HashMap::new()),
            audio_callback_count: Arc::new(AtomicU64::new(0)),
            audio_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Drop every resident local engine. Returns true if anything was loaded.
    /// In-flight inference is unaffected — it holds its own Arc clone.
    #[cfg(feature = "local-stt")]
    pub fn unload_local_models(&self) -> bool {
        let whisper_unloaded = self
            .whisper_ctx
            .lock()
            .map(|mut guard| guard.take().is_some())
            .unwrap_or(false);
        #[cfg(feature = "parakeet")]
        let parakeet_unloaded = self
            .parakeet_engine
            .lock()
            .map(|mut guard| guard.take().is_some())
            .unwrap_or(false);
        #[cfg(not(feature = "parakeet"))]
        let parakeet_unloaded = false;
        whisper_unloaded | parakeet_unloaded
    }
}
