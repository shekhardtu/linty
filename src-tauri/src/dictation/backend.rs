//! Platform adapter. Pipeline order and failure policy can be exercised without
//! a webview, microphone, model, network connection or system clipboard.
use super::{Options, Session};
use crate::{delivery::Delivery, reformat, transcribe::Transcription};
use serde_json::Value;
use std::{future::Future, sync::Arc};
use tauri::{Emitter, Manager};

pub(super) trait Backend: Sync {
    fn stage(&self, session: &Session, stage: &str) -> Result<(), String>;
    fn prepare<'a>(
        &'a self,
        options: &'a Options,
    ) -> impl Future<Output = Result<(), String>> + Send + 'a;
    fn transcribe<'a>(
        &'a self,
        options: &'a Options,
    ) -> impl Future<Output = Result<Transcription, String>> + Send + 'a;
    fn cleanup(
        &self,
        text: String,
        language: String,
        options: reformat::Options,
    ) -> impl Future<Output = Result<reformat::ReformatResult, String>> + Send;
    fn cancel_cleanup(&self);
    fn save(
        &self,
        record: Value,
        generation: u64,
    ) -> impl Future<Output = Result<(), String>> + Send;
    fn update(&self, id: String, record: Value) -> impl Future<Output = Result<(), String>> + Send;
    fn remove(&self, id: String) -> impl Future<Output = Result<(), String>> + Send;
    fn deliver(
        &self,
        session: Arc<Session>,
        id: String,
        text: String,
    ) -> impl Future<Output = Result<Delivery, String>> + Send;
    fn changed(&self);
}
pub(super) struct NativeBackend {
    pub app: tauri::AppHandle,
}
impl Backend for NativeBackend {
    fn stage(&self, session: &Session, stage: &str) -> Result<(), String> {
        session.stage(&self.app, stage)
    }
    async fn prepare(&self, options: &Options) -> Result<(), String> {
        super::prepare(&self.app, options).await
    }
    async fn transcribe(&self, options: &Options) -> Result<Transcription, String> {
        let language = (options.language != "auto").then(|| options.language.clone());
        let prompt = (!options.prompt.is_empty()).then(|| options.prompt.clone());
        crate::transcribe_buffer(
            self.app.clone(),
            self.app.state(),
            prompt,
            language,
            options.auto_detect_languages.clone(),
            Some(options.vocabulary.clone()),
            options.filename.clone(),
        )
        .await
    }
    async fn cleanup(
        &self,
        text: String,
        language: String,
        options: reformat::Options,
    ) -> Result<reformat::ReformatResult, String> {
        reformat::reformat_transcript(self.app.clone(), self.app.state(), text, language, options)
            .await
    }
    fn cancel_cleanup(&self) {
        self.app.state::<reformat::ReformatState>().cancel();
    }
    async fn save(&self, record: Value, generation: u64) -> Result<(), String> {
        crate::history::history_save(self.app.clone(), record, Some(generation)).await
    }
    async fn update(&self, id: String, record: Value) -> Result<(), String> {
        crate::history::update_pipeline(self.app.clone(), id, record).await
    }
    async fn remove(&self, id: String) -> Result<(), String> {
        crate::history::history_delete(self.app.clone(), id)
            .await
            .map(|_| ())
    }
    async fn deliver(
        &self,
        session: Arc<Session>,
        id: String,
        text: String,
    ) -> Result<Delivery, String> {
        let app = self.app.clone();
        tokio::task::spawn_blocking(move || {
            crate::delivery::deliver(
                &app,
                &text,
                &id,
                session.options.observe_corrections,
                || session.check(),
            )
        })
        .await
        .map_err(|e| e.to_string())
    }
    fn changed(&self) {
        let _ = self.app.emit_to("main", "dictation-history-changed", ());
    }
}
