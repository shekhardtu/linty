//! Remove retired preferences and credentials on upgrade. Nothing reads or uses
//! the old credential. Failed deletion is retried on the next launch.
use tauri::Runtime;
use tauri_plugin_store::StoreExt;

pub fn remove_retired_settings<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let store = app
        .store("linty-settings.json")
        .map_err(|e| e.to_string())?;
    purge_preferences(&store)?;
    #[cfg(target_os = "macos")]
    match security_framework::passwords::delete_generic_password("ai.linty.desktop.groq", "api-key")
    {
        Ok(()) => (),
        Err(error) if error.code() == -25300 => (), // Already absent.
        Err(error) => {
            return Err(format!(
                "Could not remove retired credential ({})",
                error.code()
            ))
        }
    }
    Ok(())
}

fn purge_preferences<R: Runtime>(store: &tauri_plugin_store::Store<R>) -> Result<(), String> {
    let mut changed = false;
    for key in [
        "sttMode",
        "groqApiKey",
        "correctionEnabled",
        "correctionPrompt",
    ] {
        changed |= store.delete(key);
    }
    if changed {
        store.save().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    #[test]
    fn upgrade_purges_retired_preferences_from_disk_without_changing_language_or_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let app = mock_builder()
            .plugin(tauri_plugin_store::Builder::new().build())
            .build(mock_context(noop_assets()))
            .unwrap();
        let store = app.store(&path).unwrap();
        for key in [
            "sttMode",
            "groqApiKey",
            "correctionEnabled",
            "correctionPrompt",
        ] {
            store.set(key, json!("retired-synthetic-value"));
        }
        store.set("transcriptionLanguage", json!("hi"));
        store.set("reformatEnabled", json!(true));
        store.set("onboardingComplete", json!(true));
        store.save().unwrap();
        purge_preferences(&store).unwrap();
        store.reload_ignore_defaults().unwrap();
        let expected =
            json!({"transcriptionLanguage":"hi","reformatEnabled":true,"onboardingComplete":true});
        let disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(disk, expected);
        assert_eq!(store.length(), 3);
        purge_preferences(&store).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(path).unwrap()).unwrap(),
            expected
        );
    }
}
