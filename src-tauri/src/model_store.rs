//! Model IDs and trusted artifact metadata belong to the native side.
use std::path::{Path, PathBuf};

pub const WHISPER_ID: &str = "ggml-large-v3-turbo-q5_0.bin";
pub const WHISPER_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin";
pub const WHISPER_BYTES: u64 = 574_041_195;
pub const WHISPER_SHA256: &str = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";

pub fn validate_speech_id(id: &str) -> Result<(), String> {
    if matches!(id, WHISPER_ID | crate::transcribe::PARAKEET_V3_ID) {
        Ok(())
    } else {
        Err("Unknown speech model. Choose your dictation language in Settings → Language.".into())
    }
}

pub fn speech_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_speech_id(id)?;
    model_path(root, id)
}

pub fn vocabulary_path(root: &Path) -> Result<PathBuf, String> {
    model_path(root, crate::transcribe::PARAKEET_CTC_ID)
}

fn model_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    // Reject links, including dangling ones and links inside CoreML bundles.
    // None of the supported model IDs contains path components.
    reject_link(root)?;
    let path = root.join(id);
    reject_links_recursively(&path)?;
    Ok(path)
}

fn reject_link(path: &Path) -> Result<Option<std::fs::Metadata>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Model storage must not contain symbolic links.".into())
        }
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not inspect model storage: {error}")),
    }
}

fn reject_links_recursively(path: &Path) -> Result<(), String> {
    if let Some(metadata) = reject_link(path)? {
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
                reject_links_recursively(&entry.map_err(|e| e.to_string())?.path())?;
            }
        }
    }
    Ok(())
}

pub fn verify_artifact(
    received: u64,
    digest: &str,
    expected_bytes: u64,
    expected_digest: &str,
) -> Result<(), String> {
    if received != expected_bytes || digest != expected_digest {
        return Err("Model integrity check failed. Please download the model again.".into());
    }
    Ok(())
}

/// Preserve the lowercase, zero-padded checksum format used by model catalogs.
/// sha2 0.11 returns an array that no longer implements LowerHex.
pub fn sha256_hex(digest: sha2::digest::Output<sha2::Sha256>) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_catalog_ids_can_address_storage() {
        let dir = tempfile::tempdir().unwrap();
        for id in [
            "../settings.json",
            "/tmp/victim",
            "",
            ".",
            "..",
            "model.bin",
            "parakeet-tdt-0.6b-v3/../victim",
        ] {
            assert!(speech_path(dir.path(), id).is_err(), "{id}");
        }
        assert_eq!(
            speech_path(dir.path(), WHISPER_ID).unwrap(),
            dir.path().join(WHISPER_ID)
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_linked_root_file_and_bundle_contents() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir.path().join("models");
        symlink(outside.path(), &root).unwrap();
        assert!(speech_path(&root, WHISPER_ID).is_err());
        std::fs::remove_file(&root).unwrap();
        std::fs::create_dir(&root).unwrap();
        symlink(outside.path().join("missing"), root.join(WHISPER_ID)).unwrap();
        assert!(speech_path(&root, WHISPER_ID).is_err());
        let bundle = root.join(crate::transcribe::PARAKEET_V3_ID);
        std::fs::create_dir(&bundle).unwrap();
        symlink(outside.path(), bundle.join("model.mlmodelc")).unwrap();
        assert!(speech_path(&root, crate::transcribe::PARAKEET_V3_ID).is_err());
    }

    #[test]
    fn rejects_corrupt_truncated_and_empty_artifacts() {
        use sha2::{Digest, Sha256};
        let digest = sha256_hex(Sha256::digest(b"model"));
        assert!(verify_artifact(5, &digest, 5, &digest).is_ok());
        assert!(verify_artifact(0, &digest, 5, &digest).is_err());
        assert!(verify_artifact(4, &digest, 5, &digest).is_err());
        assert!(verify_artifact(6, &digest, 5, &digest).is_err());
        assert!(verify_artifact(5, "corrupt", 5, &digest).is_err());
    }

    #[test]
    fn sha256_matches_known_vector_and_preserves_leading_zeroes() {
        use sha2::{Digest, Sha256};
        assert_eq!(
            sha256_hex(Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sha256_hex([0; 32].into()), "00".repeat(32));
    }
}
