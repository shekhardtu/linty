//! NVIDIA Parakeet TDT v3 on the Apple Neural Engine, via FluidAudio.
//!
//! The Swift side lives in `swift/Sources/LintyParakeet/Bridge.swift` and is
//! compiled by `build.rs` into a static library when the `parakeet` feature is
//! on. Every bridge call blocks the calling thread until the underlying Swift
//! Task finishes, so callers must run these on a blocking thread — never on the
//! main thread, which FluidAudio's tasks may need for CoreML work.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::vocabulary::{VocabReplacement, VocabTerm};

type ProgressFn = unsafe extern "C" fn(f64, *mut c_void);

extern "C" {
    fn linty_parakeet_is_supported() -> i32;
    fn linty_parakeet_models_exist(dir: *const c_char) -> i32;
    fn linty_parakeet_download(
        dir: *const c_char,
        progress: Option<ProgressFn>,
        ctx: *mut c_void,
        out_error: *mut *mut c_char,
    ) -> i32;
    fn linty_parakeet_load(dir: *const c_char, out_error: *mut *mut c_char) -> *mut c_void;
    fn linty_parakeet_has_speech(
        handle: *mut c_void,
        samples: *const f32,
        count: u32,
        out_error: *mut *mut c_char,
    ) -> i32;
    fn linty_parakeet_transcribe(
        handle: *mut c_void,
        samples: *const f32,
        count: u32,
        language: *const c_char,
        out_text: *mut *mut c_char,
        out_processing_secs: *mut f64,
        out_error: *mut *mut c_char,
    ) -> i32;
    fn linty_parakeet_free(handle: *mut c_void);
    fn linty_parakeet_free_string(s: *mut c_char);
    // ── Custom vocabulary (CTC keyword spotter) ──
    fn linty_parakeet_load_ctc(
        handle: *mut c_void,
        dir: *const c_char,
        out_error: *mut *mut c_char,
    ) -> i32;
    fn linty_parakeet_transcribe_vocab(
        handle: *mut c_void,
        samples: *const f32,
        count: u32,
        language: *const c_char,
        terms_json: *const c_char,
        out_text: *mut *mut c_char,
        out_replacements_json: *mut *mut c_char,
        out_processing_secs: *mut f64,
        out_error: *mut *mut c_char,
    ) -> i32;
}

/// Take ownership of a bridge-allocated C string, returning `fallback` when null.
fn take_string(ptr: *mut c_char, fallback: &str) -> String {
    if ptr.is_null() {
        return fallback.to_string();
    }
    // SAFETY: the bridge returns a NUL-terminated string it allocated with
    // strdup; we copy it out and release it exactly once.
    unsafe {
        let s = CStr::from_ptr(ptr).to_string_lossy().into_owned();
        linty_parakeet_free_string(ptr);
        s
    }
}

fn path_cstring(dir: &Path) -> Result<CString, String> {
    CString::new(dir.to_string_lossy().as_bytes())
        .map_err(|_| "Model directory path contains a NUL byte".to_string())
}

/// True when this Mac can run the CoreML Parakeet models (Apple Silicon).
pub fn is_supported() -> bool {
    // SAFETY: pure query with no arguments.
    unsafe { linty_parakeet_is_supported() != 0 }
}

/// True when a complete Parakeet TDT v3 bundle is present in `dir`.
pub fn models_exist(dir: &Path) -> bool {
    let Ok(c_dir) = path_cstring(dir) else {
        return false;
    };
    // SAFETY: c_dir outlives the call.
    unsafe { linty_parakeet_models_exist(c_dir.as_ptr()) != 0 }
}

/// Download (and CoreML-compile) the Parakeet TDT v3 bundle into `dir`.
/// `on_progress` receives a 0.0–1.0 fraction from FluidAudio's downloader; it may
/// be invoked from any thread, so it is serialized through a mutex.
pub fn download<F>(dir: &Path, on_progress: F) -> Result<(), String>
where
    F: FnMut(f64) + Send,
{
    unsafe extern "C" fn trampoline<F: FnMut(f64) + Send>(fraction: f64, ctx: *mut c_void) {
        // SAFETY: ctx points at the Mutex<F> owned by `download`, which
        // outlives the blocking bridge call that fires this callback.
        let slot = &*(ctx as *const Mutex<F>);
        if let Ok(mut f) = slot.lock() {
            f(fraction);
        }
    }

    let c_dir = path_cstring(dir)?;
    let slot = Mutex::new(on_progress);
    let mut err: *mut c_char = std::ptr::null_mut();

    // SAFETY: all pointers are valid for the duration of the synchronous call.
    let rc = unsafe {
        linty_parakeet_download(
            c_dir.as_ptr(),
            Some(trampoline::<F>),
            &slot as *const Mutex<F> as *mut c_void,
            &mut err,
        )
    };

    if rc == 0 {
        Ok(())
    } else {
        Err(take_string(err, "Parakeet download failed"))
    }
}

/// Text plus the bridge-measured inference time for one transcription.
pub struct ParakeetResult {
    pub text: String,
    pub processing_secs: f64,
}

/// A Parakeet model resident on the Neural Engine. Cheap to share behind an
/// `Arc`; inference calls are serialized by FluidAudio's actor.
pub struct ParakeetEngine {
    handle: *mut c_void,
    /// Set once the CTC keyword-spotter models are loaded alongside the TDT model.
    vocabulary_ready: AtomicBool,
    /// Serializes CTC preparation across startup and dictionary changes.
    vocabulary_load: Mutex<()>,
}

// SAFETY: the Swift side is an actor with no thread affinity, and the raw
// handle is only ever passed back to that same bridge.
unsafe impl Send for ParakeetEngine {}
unsafe impl Sync for ParakeetEngine {}

impl ParakeetEngine {
    /// A detector error must not discard a user's dictation. A missing detector
    /// also permits speech if a detector is unavailable at runtime.
    pub fn has_speech(&self, samples: &[f32]) -> bool {
        let Ok(count) = u32::try_from(samples.len()) else {
            return true;
        };
        let mut error = std::ptr::null_mut();
        // SAFETY: the engine, sample buffer, and out pointer outlive this
        // synchronous call. The Swift actor owns the detector's state.
        let result =
            unsafe { linty_parakeet_has_speech(self.handle, samples.as_ptr(), count, &mut error) };
        if result < 0 {
            log::warn!(
                "[speech-presence] Detection failed; retaining audio: {}",
                take_string(error, "unknown error")
            );
            return true;
        }
        result != 0
    }

    /// Load the bundle in `dir`. First load after download compiles the CoreML
    /// models for the Neural Engine and can take 20–30 s; later loads take ~1 s.
    pub fn load(dir: &Path) -> Result<Self, String> {
        let c_dir = path_cstring(dir)?;
        let mut err: *mut c_char = std::ptr::null_mut();
        // SAFETY: c_dir outlives the call; err is written only on failure.
        let handle = unsafe { linty_parakeet_load(c_dir.as_ptr(), &mut err) };
        if handle.is_null() {
            return Err(take_string(err, "Parakeet load failed"));
        }
        let engine = Self {
            handle,
            vocabulary_ready: AtomicBool::new(false),
            vocabulary_load: Mutex::new(()),
        };
        // Loading must finish inference setup before this instance is published.
        // Bypass the speech gate so synthetic silence actually runs the decoder.
        let started = std::time::Instant::now();
        engine.transcribe(&vec![0.0; 16000], None)?;
        log::info!(
            "[stt] Parakeet inference prepared in {}ms",
            started.elapsed().as_millis()
        );
        Ok(engine)
    }

    /// Transcribe 16 kHz mono samples. `language` is an ISO 639-1 hint or
    /// `None` for auto-detection. Empty input yields empty text.
    pub fn transcribe(
        &self,
        samples: &[f32],
        language: Option<&str>,
    ) -> Result<ParakeetResult, String> {
        if samples.is_empty() {
            return Ok(ParakeetResult {
                text: String::new(),
                processing_secs: 0.0,
            });
        }
        let count = u32::try_from(samples.len())
            .map_err(|_| "Audio too long for a single Parakeet call".to_string())?;

        let c_lang = match language {
            Some(code) if !code.is_empty() => {
                Some(CString::new(code).map_err(|_| "Invalid language code".to_string())?)
            }
            _ => None,
        };
        let lang_ptr = c_lang.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());

        let mut text: *mut c_char = std::ptr::null_mut();
        let mut processing_secs = 0.0f64;
        let mut err: *mut c_char = std::ptr::null_mut();

        // SAFETY: the sample slice, language string and out-params all outlive
        // this synchronous call.
        let rc = unsafe {
            linty_parakeet_transcribe(
                self.handle,
                samples.as_ptr(),
                count,
                lang_ptr,
                &mut text,
                &mut processing_secs,
                &mut err,
            )
        };

        if rc != 0 {
            return Err(take_string(err, "Parakeet transcription failed"));
        }
        Ok(ParakeetResult {
            text: take_string(text, ""),
            processing_secs,
        })
    }
}

pub struct ParakeetVocabResult {
    /// Untouched TDT transcript; apply `replacements` selectively.
    pub text: String,
    pub replacements: Vec<VocabReplacement>,
    pub processing_secs: f64,
}

impl ParakeetEngine {
    /// Download (if needed) and load the Parakeet CTC 110M models used for
    /// keyword spotting into `dir`. Required before `transcribe_with_vocabulary`.
    pub fn load_ctc(&self, dir: &Path) -> Result<(), String> {
        let _guard = self.vocabulary_load.lock().map_err(|e| e.to_string())?;
        if self.vocabulary_ready.load(Ordering::Acquire) {
            return Ok(());
        }
        let c_dir = path_cstring(dir)?;
        let mut err: *mut c_char = std::ptr::null_mut();
        // SAFETY: c_dir outlives the call; err is written only on failure.
        let rc = unsafe { linty_parakeet_load_ctc(self.handle, c_dir.as_ptr(), &mut err) };
        if rc == 0 {
            self.vocabulary_ready.store(true, Ordering::Release);
            Ok(())
        } else {
            Err(take_string(err, "Parakeet CTC load failed"))
        }
    }

    /// True once `load_ctc` succeeded for this engine instance.
    pub fn has_vocabulary_models(&self) -> bool {
        self.vocabulary_ready.load(Ordering::Acquire)
    }

    /// Transcribe with vocabulary boosting: the TDT transcript is rescored
    /// against `terms` using the CTC keyword spotter (FluidAudio custom vocabulary).
    /// The returned text is untouched; apply `replacements` through
    /// `vocabulary::apply_replacements`, which gates the rescorer's over-reach.
    pub fn transcribe_with_vocabulary(
        &self,
        samples: &[f32],
        language: Option<&str>,
        terms: &[VocabTerm],
    ) -> Result<ParakeetVocabResult, String> {
        if samples.is_empty() {
            return Ok(ParakeetVocabResult {
                text: String::new(),
                replacements: Vec::new(),
                processing_secs: 0.0,
            });
        }
        let count = u32::try_from(samples.len())
            .map_err(|_| "Audio too long for a single Parakeet call".to_string())?;
        let terms_json = serde_json::to_string(terms).map_err(|e| e.to_string())?;
        let c_terms = CString::new(terms_json).map_err(|_| "Invalid vocabulary".to_string())?;
        let c_lang = match language {
            Some(code) if !code.is_empty() => {
                Some(CString::new(code).map_err(|_| "Invalid language code".to_string())?)
            }
            _ => None,
        };
        let lang_ptr = c_lang.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());

        let mut text: *mut c_char = std::ptr::null_mut();
        let mut replacements: *mut c_char = std::ptr::null_mut();
        let mut processing_secs = 0.0f64;
        let mut err: *mut c_char = std::ptr::null_mut();
        // SAFETY: every pointer outlives this synchronous call; out-params are
        // bridge-allocated strings released by take_string.
        let rc = unsafe {
            linty_parakeet_transcribe_vocab(
                self.handle,
                samples.as_ptr(),
                count,
                lang_ptr,
                c_terms.as_ptr(),
                &mut text,
                &mut replacements,
                &mut processing_secs,
                &mut err,
            )
        };
        if rc != 0 {
            return Err(take_string(err, "Parakeet vocabulary transcription failed"));
        }
        let replacements_json = take_string(replacements, "[]");
        let replacements: Vec<VocabReplacement> = serde_json::from_str(&replacements_json)
            .unwrap_or_else(|e| {
                // serde_json's message quotes the value it failed on, which here
                // is transcript text; log only where and what kind of error.
                log::warn!(
                    "[parakeet] ignoring unreadable vocabulary replacements: {:?} error at line {} column {}",
                    e.classify(),
                    e.line(),
                    e.column()
                );
                Vec::new()
            });
        Ok(ParakeetVocabResult {
            text: take_string(text, ""),
            replacements,
            processing_secs,
        })
    }
}

impl Drop for ParakeetEngine {
    fn drop(&mut self) {
        // SAFETY: handle came from linty_parakeet_load and is released once.
        unsafe { linty_parakeet_free(self.handle) };
    }
}
