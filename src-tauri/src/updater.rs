//! Bound connection attempts separately from the full update transfer. A CDN
//! can resolve to several addresses; an unreachable first address must not
//! consume the entire request timeout before the connector tries the others.

use serde::Serialize;
use std::time::Duration;
use tauri::{Manager, ResourceId, Runtime, Webview};
use tauri_plugin_updater::UpdaterExt;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Matches the metadata consumed by the updater plugin's JavaScript Update.
/// Keep the resource in the calling webview so the plugin still owns download,
/// signature verification, installation, and resource cleanup.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

#[tauri::command]
pub async fn check_for_update<R: Runtime>(
    webview: Webview<R>,
) -> Result<Option<UpdateMetadata>, String> {
    let update = webview
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        // The plugin carries this configuration into the Update resource,
        // applying it to both the manifest and the signed archive download.
        .configure_client(|client| {
            client
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(READ_TIMEOUT)
        })
        .build()
        .map_err(check_error)?
        .check()
        .await
        .map_err(check_error)?;

    Ok(update.map(|update| UpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update.date.and_then(|date| {
            date.format(&time::format_description::well_known::Rfc3339)
                .ok()
        }),
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    }))
}

fn check_error(error: tauri_plugin_updater::Error) -> String {
    let message = error.to_string();
    if let tauri_plugin_updater::Error::Reqwest(network_error) = error {
        // Keep the useful cause (connection/read timeout, TLS, DNS), while
        // excluding redirected asset URLs that may contain temporary tokens.
        log::warn!("[updater] Check failed: {:?}", network_error.without_url());
    } else {
        log::warn!("[updater] Check failed: {message}");
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn macos_update_replaces_the_existing_bundle_without_an_extra_app() {
        // Exercise the actual plugin installer on a disposable app, never /Applications.
        let root = tempfile::tempdir().unwrap();
        let applications = root.path().join("Applications");
        let installed = applications.join("Linty.app");
        let executable = installed.join("Contents/MacOS/linty");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, "old executable").unwrap();
        std::fs::write(installed.join("Contents/obsolete"), "old resource").unwrap();
        let unrelated = applications.join("Other.app");
        std::fs::create_dir(&unrelated).unwrap();
        std::fs::write(unrelated.join("keep"), "untouched").unwrap();
        let customer_data = root
            .path()
            .join("Library/Application Support/Linty/history.json");
        std::fs::create_dir_all(customer_data.parent().unwrap()).unwrap();
        std::fs::write(&customer_data, "saved customer history").unwrap();
        let stage = root.path().join("stage");
        let incoming = stage.join("Linty.app/Contents/MacOS");
        std::fs::create_dir_all(&incoming).unwrap();
        std::fs::write(incoming.join("linty"), "new executable").unwrap();
        let archive = root.path().join("update.tar.gz");
        assert!(std::process::Command::new("/usr/bin/tar")
            .arg("--no-mac-metadata")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&stage)
            .arg("Linty.app")
            .status()
            .unwrap()
            .success());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = json!({ "version": "999.0.0", "url": format!("http://{address}/archive"), "signature": "unused-in-install-test" }).to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).await.unwrap();
            let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            stream.write_all(headers.as_bytes()).await.unwrap();
            stream.write_all(body.as_bytes()).await.unwrap();
        });
        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            json!({
                "pubkey": "unused-in-install-test", "dangerousInsecureTransportProtocol": true,
            }),
        );
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let update = app
            .updater_builder()
            .executable_path(&executable)
            .endpoints(vec![format!("http://{address}/latest.json")
                .parse()
                .unwrap()])
            .unwrap()
            .build()
            .unwrap()
            .check()
            .await
            .unwrap()
            .unwrap();
        // Download signature enforcement is covered by the adjacent test. These
        // synthetic bytes exercise only replacement, with no installed customer app.
        update.install(std::fs::read(archive).unwrap()).unwrap();
        server.await.unwrap();
        assert_eq!(
            std::fs::read_to_string(executable).unwrap(),
            "new executable"
        );
        assert!(!installed.join("Contents/obsolete").exists());
        assert!(!installed.join(".metadata_never_index").exists());
        assert_eq!(
            std::fs::read_to_string(unrelated.join("keep")).unwrap(),
            "untouched"
        );
        assert_eq!(
            std::fs::read_to_string(customer_data).unwrap(),
            "saved customer history"
        );
        let mut entries: Vec<_> = std::fs::read_dir(applications)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        entries.sort();
        assert_eq!(entries, ["Linty.app", "Other.app"]);
    }

    #[tokio::test]
    async fn native_check_preserves_required_metadata_and_signed_download_resource() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let manifest = json!({
            "version": "999.0.0",
            "minimum_version": "999.0.0",
            "notes": "- Updates recover from stalled connections.",
            "url": format!("http://{address}/archive"),
            "signature": "invalid-signature",
        });
        let expected = manifest.clone();
        let server = tokio::spawn(async move {
            for body in [
                manifest.to_string().into_bytes(),
                b"unsigned archive".to_vec(),
            ] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                stream.read(&mut request).await.unwrap();
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(headers.as_bytes()).await.unwrap();
                stream.write_all(&body).await.unwrap();
                stream.shutdown().await.unwrap();
            }
        });
        let mut context = mock_context(noop_assets());
        let production: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        context.config_mut().plugins.0.insert(
            "updater".into(),
            json!({
                "endpoints": [format!("http://{address}/latest.json")],
                "pubkey": production["plugins"]["updater"]["pubkey"],
                // Only this loopback test uses HTTP; production retains HTTPS.
                "dangerousInsecureTransportProtocol": true,
            }),
        );
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let webview: Webview<_> = window.as_ref().clone();
        let metadata = check_for_update(webview.clone()).await.unwrap().unwrap();
        let serialized = serde_json::to_value(&metadata).unwrap();
        assert_eq!(serialized["version"], "999.0.0");
        assert_eq!(serialized["rawJson"], expected);
        assert!(serialized["currentVersion"].is_string());
        assert!(serialized["rid"].is_number());

        let update = webview
            .resources_table()
            .get::<tauri_plugin_updater::Update>(metadata.rid)
            .unwrap();
        let error = update.download(|_, _| {}, || {}).await.unwrap_err();
        assert!(matches!(error, tauri_plugin_updater::Error::Base64(_)));
        webview.resources_table().close(metadata.rid).unwrap();
        server.await.unwrap();
    }
}
