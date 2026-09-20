//! Intel Macs use Whisper. Keep the public backend API available to shared
//! callers and benchmark tools without linking FluidAudio or its ARM archive.
use crate::vocabulary::{VocabReplacement, VocabTerm};
use std::path::Path;

const UNSUPPORTED: &str =
    "Parakeet requires Apple silicon. Choose your dictation language to use Whisper on this Mac.";

pub fn is_supported() -> bool {
    false
}

pub fn models_exist(_dir: &Path) -> bool {
    false
}

pub fn download<F>(_dir: &Path, _on_progress: F) -> Result<(), String>
where
    F: FnMut(f64) + Send,
{
    Err(UNSUPPORTED.into())
}

pub struct ParakeetResult {
    pub text: String,
    pub processing_secs: f64,
}

pub struct ParakeetVocabResult {
    pub text: String,
    pub replacements: Vec<VocabReplacement>,
    pub processing_secs: f64,
}

// Callers cannot construct this backend; loading always returns an error.
pub struct ParakeetEngine {
    _private: (),
}

impl ParakeetEngine {
    pub fn load(_dir: &Path) -> Result<Self, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn has_speech(&self, _samples: &[f32]) -> bool {
        true
    }

    pub fn transcribe(
        &self,
        _samples: &[f32],
        _language: Option<&str>,
    ) -> Result<ParakeetResult, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn load_ctc(&self, _dir: &Path) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn has_vocabulary_models(&self) -> bool {
        false
    }

    pub fn transcribe_with_vocabulary(
        &self,
        _samples: &[f32],
        _language: Option<&str>,
        _terms: &[VocabTerm],
    ) -> Result<ParakeetVocabResult, String> {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intel_offers_whisper_and_rejects_parakeet_without_touching_disk_or_network() {
        let models = crate::transcribe::available_models(is_supported());
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].backend, crate::transcribe::ModelBackend::Whisper);
        assert!(models[0].description.contains("CPU"));
        let missing = Path::new("/nonexistent/linty-parakeet");
        assert!(!models_exist(missing));
        assert!(download(missing, |_| panic!("must not download")).is_err());
        assert!(ParakeetEngine::load(missing).is_err());
    }
}
