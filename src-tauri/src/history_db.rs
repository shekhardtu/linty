//! Indexed, local history. UI caches are never the authority for retained records.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Arc;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub const DATABASE: &str = "linty-history.sqlite3";
pub const AUDIO_READ_LIMIT: usize = 1024 * 1024;
pub const CLEANUP_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
const LEGACY: [(&str, &str); 2] = [
    ("linty-history.json", "transcripts"),
    ("linty-corrections.json", "corrections"),
];
pub struct HistoryDb {
    conn: Connection,
}

/// Audio is held in memory until its transcript is committed. The consent epoch
/// prevents an in-flight dictation from saving after consent is revoked.
pub struct PendingAudio {
    pub generation: u64,
    pub consent_epoch: i64,
    pub samples: Arc<Vec<f32>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub timestamp: i64,
    pub end: i64,
    pub label: String,
    pub full_label: String,
}
#[derive(Serialize, Deserialize)]
pub struct DeletedTranscript {
    pub transcript: Value,
    pub corrections: Vec<Value>,
    pub generation: i64,
}

fn required_str<'a>(record: &'a Value, key: &str) -> Result<&'a str> {
    record
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| key != "transcriptId" && key != "correctionId" || !s.is_empty())
        .ok_or_else(|| {
            format!(
                "History record has a missing or invalid {key}; the original file has been kept."
            )
            .into()
        })
}
fn timestamp(record: &Value) -> Result<i64> {
    record["timestamp"]
        .as_i64()
        .filter(|n| *n >= 0)
        .ok_or_else(|| "Invalid history timestamp; the original file has been kept.".into())
}
fn number(record: &Value, key: &str) -> f64 {
    record[key]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .unwrap_or(0.0)
}
fn put_transcript(conn: &Connection, original: &Value, replace: bool) -> Result<()> {
    let id = required_str(original, "transcriptId")?;
    let text = required_str(original, "finalText")?;
    let time = timestamp(original)?;
    let words = original["wordCount"]
        .as_i64()
        .filter(|n| *n >= 0)
        .unwrap_or_else(|| text.split_whitespace().count() as i64);
    let engine = if original["engine"] == "cloud" {
        "cloud"
    } else {
        "local"
    };
    let app_name = original["application"]["name"].as_str();
    let app_bundle = original["application"]["bundleId"]
        .as_str()
        .filter(|s| !s.is_empty());
    let search = format!(
        "{} {} {}",
        text,
        app_name.unwrap_or(""),
        app_bundle.unwrap_or("")
    )
    .to_lowercase();
    let mut record = original.clone();
    // Only native storage can claim that a recording exists. In particular,
    // restoring deleted text must never resurrect an audio attachment.
    record.as_object_mut().unwrap().remove("audio");
    let bytes: Option<i64> = conn
        .query_row(
            "SELECT length(wav) FROM transcript_audio WHERE transcript_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(bytes) = bytes {
        record["audio"] = audio_metadata(bytes);
    }
    // Older versions omitted some metadata. Preserve original text and unknown fields.
    for (key, default) in [
        ("rawText", json!(text)),
        ("wordCount", json!(words)),
        ("durationSeconds", json!(0)),
        ("processingTimeMs", json!(0)),
        ("engine", json!(engine)),
        ("modelName", json!("")),
        ("corrected", json!(false)),
    ] {
        if record.get(key).is_none() {
            record[key] = default;
        }
    }
    let conflict = if replace {
        "DO UPDATE SET timestamp=excluded.timestamp,words=excluded.words,seconds=excluded.seconds,processing_ms=excluded.processing_ms,engine=excluded.engine,app_name=excluded.app_name,app_bundle=excluded.app_bundle,search_text=excluded.search_text,payload=excluded.payload"
    } else {
        "DO NOTHING"
    };
    conn.execute(&format!("INSERT INTO transcripts(id,timestamp,words,seconds,processing_ms,engine,app_name,app_bundle,search_text,payload) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) {conflict}"), params![id,time,words,number(original,"durationSeconds"),number(original,"processingTimeMs"),engine,app_name,app_bundle,search,serde_json::to_string(&record)?])?;
    Ok(())
}
fn put_correction(conn: &Connection, record: &Value) -> Result<()> {
    let count = if record["rewrite"] == true {
        1
    } else {
        record["pairs"].as_array().map_or(0, Vec::len)
    };
    conn.execute("INSERT INTO corrections(id,transcript_id,timestamp,changes,payload) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO NOTHING",params![required_str(record,"correctionId")?,required_str(record,"transcriptId")?,timestamp(record)?,count as i64,serde_json::to_string(record)?])?;
    Ok(())
}
fn payloads<P: rusqlite::Params>(conn: &Connection, sql: &str, params: P) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, |row| row.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}
fn bump(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE history_settings SET revision=revision+1 WHERE id=1",
        [],
    )?;
    Ok(())
}
fn audio_metadata(bytes: i64) -> Value {
    json!({"format":"wav","sampleRate":16000,"channels":1,"bitsPerSample":16,"bytes":bytes})
}
fn valid_retention(days: i64) -> Result<()> {
    if [0, 30, 90, 365].contains(&days) {
        Ok(())
    } else {
        Err("Unsupported history retention period".into())
    }
}
fn cutoff(now: i64, days: i64) -> i64 {
    if days == 0 {
        0
    } else {
        now.saturating_sub(days * 86_400_000).max(0)
    }
}
fn erase_before(conn: &Connection, before: i64) -> Result<usize> {
    conn.execute("DELETE FROM corrections WHERE transcript_id IN (SELECT id FROM transcripts WHERE timestamp < ?1) OR timestamp < ?1", [before])?;
    Ok(conn.execute("DELETE FROM transcripts WHERE timestamp < ?1", [before])?)
}

impl HistoryDb {
    pub fn open(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir)?;
        let mut conn = Connection::open(dir.join(DATABASE))?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        conn.execute_batch("PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS history_settings(id INTEGER PRIMARY KEY CHECK(id=1), retention_days INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, migrated INTEGER NOT NULL DEFAULT 0);
            INSERT OR IGNORE INTO history_settings(id) VALUES(1);
            CREATE TABLE IF NOT EXISTS history_maintenance(id INTEGER PRIMARY KEY CHECK(id=1),last_cleanup_at INTEGER);
            INSERT OR IGNORE INTO history_maintenance(id) VALUES(1);
            CREATE TABLE IF NOT EXISTS transcripts(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,words INTEGER NOT NULL,seconds REAL NOT NULL,processing_ms REAL NOT NULL,engine TEXT NOT NULL,app_name TEXT,app_bundle TEXT,search_text TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS audio_preferences(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 0,consented_at INTEGER,consent_version INTEGER);
            INSERT OR IGNORE INTO audio_preferences(id) VALUES(1);
            CREATE TABLE IF NOT EXISTS transcript_audio(transcript_id TEXT PRIMARY KEY REFERENCES transcripts(id) ON DELETE CASCADE,wav BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS audio_storage_stats(id INTEGER PRIMARY KEY CHECK(id=1),recordings INTEGER NOT NULL,bytes INTEGER NOT NULL);
            CREATE TRIGGER IF NOT EXISTS audio_stats_insert AFTER INSERT ON transcript_audio BEGIN
                UPDATE audio_storage_stats SET recordings=recordings+1,bytes=bytes+length(NEW.wav) WHERE id=1;
            END;
            CREATE TRIGGER IF NOT EXISTS audio_stats_delete AFTER DELETE ON transcript_audio BEGIN
                UPDATE audio_storage_stats SET recordings=recordings-1,bytes=bytes-length(OLD.wav) WHERE id=1;
            END;
            CREATE TRIGGER IF NOT EXISTS audio_stats_update AFTER UPDATE OF wav ON transcript_audio BEGIN
                UPDATE audio_storage_stats SET bytes=bytes+length(NEW.wav)-length(OLD.wav) WHERE id=1;
            END;
            CREATE INDEX IF NOT EXISTS history_by_time ON transcripts(timestamp DESC,id DESC);
            CREATE TABLE IF NOT EXISTS corrections(id TEXT PRIMARY KEY,transcript_id TEXT NOT NULL,timestamp INTEGER NOT NULL,changes INTEGER NOT NULL,payload TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS corrections_by_transcript ON corrections(transcript_id);")?;
        // Bootstrap an existing archive once. Incremental blob writes keep the
        // allocated length, so the insert/delete triggers maintain these totals.
        if conn
            .query_row("SELECT id FROM audio_storage_stats WHERE id=1", [], |r| {
                r.get::<_, i64>(0)
            })
            .optional()?
            .is_none()
        {
            conn.execute("INSERT INTO audio_storage_stats SELECT 1,COUNT(*),COALESCE(SUM(length(wav)),0) FROM transcript_audio", [])?;
        }
        let migrated: bool = conn.query_row(
            "SELECT migrated FROM history_settings WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        if !migrated {
            let tx = conn.transaction()?;
            for (file, key) in LEGACY {
                let path = dir.join(file);
                if !path.try_exists()? {
                    continue;
                }
                let saved: Value = serde_json::from_reader(fs::File::open(&path)?)?;
                // An empty plugin store is valid. Any malformed collection aborts the entire migration.
                if let Some(value) = saved.get(key) {
                    let records = value.as_array().ok_or(
                        "Invalid legacy history collection; original files have been kept",
                    )?;
                    let mut ids = std::collections::HashSet::new();
                    for record in records {
                        let id = required_str(
                            record,
                            if key == "transcripts" {
                                "transcriptId"
                            } else {
                                "correctionId"
                            },
                        )?;
                        if !ids.insert(id) {
                            return Err(
                                "Duplicate history IDs; original files have been kept".into()
                            );
                        }
                        if key == "transcripts" {
                            put_transcript(&tx, record, false)?;
                        } else {
                            put_correction(&tx, record)?;
                        }
                    }
                } else if !saved.is_object() {
                    return Err(
                        "Invalid legacy history store; original files have been kept".into(),
                    );
                }
            }
            tx.execute(
                "UPDATE history_settings SET migrated=1,revision=revision+1 WHERE id=1",
                [],
            )?;
            tx.commit()?;
        }
        // A committed migration is restart-safe. Never re-import deleted records from a leftover file.
        // Cleanup must succeed before mutations are allowed, so deletion also removes legacy copies.
        for (file, _) in LEGACY {
            let path = dir.join(file);
            if path.try_exists()? {
                fs::remove_file(path)?;
            }
        }
        Ok(Self { conn })
    }
    pub fn cleanup_due_at(&self) -> Result<Option<i64>> {
        if self.retention()? == 0 {
            return Ok(None);
        }
        let last: Option<i64> = self.conn.query_row(
            "SELECT last_cleanup_at FROM history_maintenance WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        Ok(Some(last.map_or(0, |last| {
            last.saturating_add(CLEANUP_INTERVAL_MS)
        })))
    }
    pub fn prune(&mut self, now: i64) -> Result<bool> {
        // Persist the gate with the deletion transaction: reopening the archive,
        // focusing the window and repeated reads cannot run another daily sweep.
        if self.cleanup_due_at()?.is_none_or(|due| now < due) {
            return Ok(false);
        }
        let days = self.retention()?;
        let tx = self.conn.transaction()?;
        let before = tx.total_changes();
        erase_before(&tx, cutoff(now, days))?;
        let changed = tx.total_changes() > before;
        if changed {
            bump(&tx)?;
        }
        tx.execute(
            "UPDATE history_maintenance SET last_cleanup_at=?1 WHERE id=1",
            [now],
        )?;
        tx.commit()?;
        Ok(changed)
    }
    pub fn retention(&self) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT retention_days FROM history_settings WHERE id=1",
            [],
            |r| r.get(0),
        )?)
    }
    pub fn snapshot(&self) -> Result<Value> {
        let (total, oldest, words): (i64, Option<i64>, i64) = self.conn.query_row(
            "SELECT COUNT(*),MIN(timestamp),COALESCE(SUM(words),0) FROM transcripts",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let (corrections,changes):(i64,i64)=self.conn.query_row("SELECT COUNT(*),COALESCE(SUM(c.changes),0) FROM corrections c JOIN transcripts t ON t.id=c.transcript_id",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let (retention, revision): (i64, i64) = self.conn.query_row(
            "SELECT retention_days,revision FROM history_settings WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let (audio_count, audio_bytes): (i64, i64) = self.conn.query_row(
            "SELECT recordings,bytes FROM audio_storage_stats WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(json!({
            "recent":payloads(&self.conn,"SELECT payload FROM transcripts ORDER BY timestamp DESC,id DESC LIMIT 20",[])?,
            "total":total,"oldestTimestamp":oldest,"totalWords":words,"milestone":self.word_milestone(words)?,
            "correctionCount":corrections,"correctionRate":rate(changes,words),"retentionDays":retention,"revision":revision,
            "saveAudio":self.audio_consent()?.is_some(),"audioCount":audio_count,"audioBytes":audio_bytes,
        }))
    }
    pub fn query(&self, query: &str, offset: i64, limit: i64) -> Result<Value> {
        let query = query.trim().to_lowercase();
        let total: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM transcripts WHERE instr(search_text,?1)>0",
            [&query],
            |r| r.get(0),
        )?;
        let records=payloads(&self.conn,"SELECT payload FROM transcripts WHERE instr(search_text,?1)>0 ORDER BY timestamp DESC,id DESC LIMIT ?2 OFFSET ?3",params![query,limit.clamp(1,100),offset.max(0)])?;
        Ok(json!({"records":records,"total":total}))
    }
    pub fn get(&self, id: &str) -> Result<Option<Value>> {
        let payload: Option<String> = self
            .conn
            .query_row("SELECT payload FROM transcripts WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(payload.map(|s| serde_json::from_str(&s)).transpose()?)
    }
    pub fn corrections(&self, id: &str) -> Result<Vec<Value>> {
        payloads(&self.conn,"SELECT payload FROM corrections WHERE transcript_id=?1 ORDER BY timestamp DESC,id DESC",[id])
    }
    pub fn save(&mut self, record: &Value, now: i64) -> Result<()> {
        self.save_with_audio(record, now, None)
    }
    pub fn save_with_audio(
        &mut self,
        record: &Value,
        now: i64,
        audio: Option<&PendingAudio>,
    ) -> Result<()> {
        if timestamp(record)? < cutoff(now, self.retention()?) {
            return Err("This transcription is outside your current retention period".into());
        }
        let consent = self.audio_consent()?;
        let tx = self.conn.transaction()?;
        put_transcript(&tx, record, true)?;
        if let Some(audio) =
            audio.filter(|a| consent == Some(a.consent_epoch) && !a.samples.is_empty())
        {
            let id = required_str(record, "transcriptId")?;
            let len = crate::pcm_wav::encoded_len(audio.samples.len())?;
            let inserted = tx.execute("INSERT INTO transcript_audio(transcript_id,wav) VALUES(?1,zeroblob(?2)) ON CONFLICT(transcript_id) DO NOTHING", params![id, len])?;
            if inserted > 0 {
                let rowid = tx.last_insert_rowid();
                let mut blob = tx.blob_open("main", "transcript_audio", "wav", rowid, false)?;
                crate::pcm_wav::write(&audio.samples, &mut blob)?;
                blob.close()?;
            }
            // Re-read attachment metadata inside the same transaction.
            put_transcript(&tx, record, true)?;
        }
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn audio_consent(&self) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row(
                "SELECT epoch FROM audio_preferences WHERE id=1 AND enabled=1",
                [],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn set_save_audio(&mut self, enabled: bool, now: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("UPDATE audio_preferences SET enabled=?1,epoch=epoch+1,consented_at=CASE WHEN ?1 THEN ?2 ELSE NULL END,consent_version=CASE WHEN ?1 THEN 1 ELSE NULL END WHERE id=1", params![enabled,now])?;
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    fn audio_blob(&self, id: &str) -> Result<Option<rusqlite::blob::Blob<'_>>> {
        let rowid: Option<i64> = self
            .conn
            .query_row(
                "SELECT rowid FROM transcript_audio WHERE transcript_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(rowid
            .map(|rowid| {
                self.conn
                    .blob_open("main", "transcript_audio", "wav", rowid, true)
            })
            .transpose()?)
    }
    pub fn audio_chunk(&self, id: &str, offset: u64, length: usize) -> Result<Vec<u8>> {
        if length == 0 || length > AUDIO_READ_LIMIT {
            return Err("Invalid audio read size".into());
        }
        let mut blob = self
            .audio_blob(id)?
            .ok_or("No saved audio for this dictation")?;
        let remaining = (blob.size() as u64)
            .checked_sub(offset)
            .ok_or("Invalid audio offset")?;
        let mut bytes = vec![0; length.min(remaining as usize)];
        blob.seek(SeekFrom::Start(offset))?;
        blob.read_exact(&mut bytes)?;
        Ok(bytes)
    }
    pub fn copy_audio(&self, id: &str, out: &mut impl Write) -> Result<u64> {
        let mut blob = self
            .audio_blob(id)?
            .ok_or("No saved audio for this dictation")?;
        Ok(std::io::copy(&mut blob, out)?)
    }
    #[cfg(test)]
    fn audio(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let Some(mut blob) = self.audio_blob(id)? else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        blob.read_to_end(&mut bytes)?;
        Ok(Some(bytes))
    }
    pub fn delete_audio(&mut self, id: Option<&str>) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM transcript_audio WHERE ?1 IS NULL OR transcript_id=?1",
            [id],
        )?;
        tx.execute("UPDATE transcripts SET payload=json_remove(payload,'$.audio') WHERE ?1 IS NULL OR id=?1", [id])?;
        // Erasing all recordings also invalidates audio still being processed.
        if id.is_none() {
            tx.execute("UPDATE audio_preferences SET epoch=epoch+1 WHERE id=1", [])?;
        }
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn patch(&mut self, id: &str, patch: &Value) -> Result<()> {
        let mut record = self.get(id)?.ok_or("Transcription no longer exists")?;
        // History editing changes text only; dictated word count and timing remain accurate.
        record["finalText"] = json!(required_str(patch, "finalText")?);
        record["userEdited"] = json!(true);
        let tx = self.conn.transaction()?;
        put_transcript(&tx, &record, true)?;
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn update_pipeline(&mut self, id: &str, patch: &Value) -> Result<()> {
        let mut record = self.get(id)?.ok_or("Transcription no longer exists")?;
        for key in [
            "finalText",
            "reformattedText",
            "pastedText",
            "attemptedText",
            "wordCount",
            "corrected",
            "releaseToInsertionMs",
            "deliveryStatus",
            "delivery",
            "processingTimeMs",
            "pasteTimeMs",
            "reformatTimeMs",
            "correctionTimeMs",
            "cloudRefinementStatus",
            "reformatting",
            "textValidation",
            "dictionaryValidation",
            "dictionaryApplied",
        ] {
            if key == "finalText" && record["userEdited"] == true {
                continue;
            }
            if let Some(value) = patch.get(key) {
                record[key] = value.clone();
            }
        }
        let tx = self.conn.transaction()?;
        put_transcript(&tx, &record, true)?;
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn add_correction(&mut self, record: &Value) -> Result<()> {
        if self.get(required_str(record, "transcriptId")?)?.is_none() {
            return Err("The transcription was deleted or expired".into());
        }
        let tx = self.conn.transaction()?;
        put_correction(&tx, record)?;
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn delete(&mut self, id: &str) -> Result<Option<DeletedTranscript>> {
        let Some(transcript) = self.get(id)? else {
            return Ok(None);
        };
        let corrections = self.corrections(id)?;
        let generation = self.conn.query_row(
            "SELECT generation FROM history_settings WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM corrections WHERE transcript_id=?1", [id])?;
        tx.execute("DELETE FROM transcripts WHERE id=?1", [id])?;
        bump(&tx)?;
        tx.commit()?;
        Ok(Some(DeletedTranscript {
            transcript,
            corrections,
            generation,
        }))
    }
    pub fn restore(&mut self, deleted: &DeletedTranscript, now: i64) -> Result<()> {
        let generation: i64 = self.conn.query_row(
            "SELECT generation FROM history_settings WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        if generation != deleted.generation {
            return Err("History was cleared or its retention changed; this deletion can no longer be undone".into());
        }
        if timestamp(&deleted.transcript)? < cutoff(now, self.retention()?) {
            return Err("This transcription has expired under your retention setting".into());
        }
        let tx = self.conn.transaction()?;
        put_transcript(&tx, &deleted.transcript, false)?;
        for c in &deleted.corrections {
            put_correction(&tx, c)?;
        }
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn clear(&mut self) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM corrections", [])?;
        tx.execute("DELETE FROM transcripts", [])?;
        tx.execute("UPDATE audio_preferences SET epoch=epoch+1 WHERE id=1", [])?;
        tx.execute(
            "UPDATE history_settings SET generation=generation+1,revision=revision+1 WHERE id=1",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn retention_preview(&self, days: i64, now: i64) -> Result<i64> {
        valid_retention(days)?;
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM transcripts WHERE timestamp < ?1",
            [cutoff(now, days)],
            |r| r.get(0),
        )?)
    }
    pub fn set_retention(&mut self, days: i64, now: i64) -> Result<()> {
        valid_retention(days)?;
        let tx = self.conn.transaction()?;
        erase_before(&tx, cutoff(now, days))?;
        // Applying a policy is an explicit immediate cleanup and starts the next
        // 24-hour interval. Re-enabling retention always cleans expired data now.
        tx.execute(
            "UPDATE history_maintenance SET last_cleanup_at=?1 WHERE id=1",
            [now],
        )?;
        tx.execute("UPDATE history_settings SET retention_days=?1,generation=generation+1,revision=revision+1 WHERE id=1",[days])?;
        tx.commit()?;
        Ok(())
    }
    /// Shared aggregate query for the visible period and its comparison period.
    pub fn usage_summary(&self, start: i64, end: i64) -> Result<Value> {
        let (words, seconds, processing, sessions, local, active_days): (i64, f64, f64, i64, i64, i64) = self.conn.query_row(
            "SELECT COALESCE(SUM(words),0),COALESCE(SUM(seconds),0),COALESCE(SUM(processing_ms),0),COUNT(*),COALESCE(SUM(engine='local'),0),COUNT(DISTINCT date(timestamp/1000,'unixepoch','localtime')) FROM transcripts WHERE timestamp>=?1 AND timestamp<=?2",
            params![start,end], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
        // Legacy records without complete timing must not create invented savings or pace.
        let (timed_words, timed_seconds, timed_processing, timed_sessions): (i64, f64, f64, i64) = self.conn.query_row(
            "SELECT COALESCE(SUM(words),0),COALESCE(SUM(seconds),0),COALESCE(SUM(processing_ms),0),COUNT(*) FROM transcripts WHERE timestamp>=?1 AND timestamp<=?2 AND words>0 AND seconds>0 AND processing_ms>0",
            params![start,end], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        Ok(json!({
            "stats":{"words":words,"seconds":seconds,"sessions":sessions,"local":local,"avgProcessingSeconds":if sessions>0{processing/sessions as f64/1000.0}else{0.0},"wordsPerMinute":if seconds>0.0{(words as f64/seconds*60.0).round()}else{0.0},"localPercent":if sessions>0{(local as f64/sessions as f64*100.0).round()}else{0.0}},
            "timing":{"words":timed_words,"seconds":timed_seconds,"processingSeconds":timed_processing/1000.0,"sessions":timed_sessions,"missingSessions":sessions-timed_sessions},
            "activeDays":active_days
        }))
    }
    /// Recomputed from retained history, so deletion/retention also removes recognition.
    fn word_milestone(&self, total: i64) -> Result<Value> {
        let mut threshold = 0;
        let mut scale = 1000_i64;
        while scale <= total {
            for value in [
                Some(scale),
                scale.checked_mul(5).map(|n| n / 2),
                scale.checked_mul(5),
            ]
            .into_iter()
            .flatten()
            {
                if value <= total {
                    threshold = value;
                }
            }
            match scale.checked_mul(10) {
                Some(next) => scale = next,
                None => break,
            }
        }
        if threshold == 0 {
            return Ok(Value::Null);
        }
        let mut stmt = self
            .conn
            .prepare("SELECT timestamp,words FROM transcripts ORDER BY timestamp,id")?;
        let mut rows = stmt.query([])?;
        let mut words = 0;
        while let Some(row) = rows.next()? {
            words += row.get::<_, i64>(1)?;
            if words >= threshold {
                return Ok(json!({"words":threshold,"timestamp":row.get::<_,i64>(0)?}));
            }
        }
        Ok(Value::Null)
    }
    pub fn usage(&self, start: i64, end: i64, buckets: &[Bucket]) -> Result<Value> {
        let summary = self.usage_summary(start, end)?;
        let sessions = summary["stats"]["sessions"].as_i64().unwrap_or(0);
        let mut stmt=self.conn.prepare("SELECT CASE WHEN app_name IS NULL THEN 'unattributed' WHEN app_bundle IS NOT NULL THEN 'bundle:'||app_bundle ELSE 'name:'||app_name END AS app_id,MAX(app_name),MAX(app_bundle),SUM(words),SUM(seconds),COUNT(*),MAX(timestamp),SUM(processing_ms),SUM(engine='local') FROM transcripts WHERE timestamp>=?1 AND timestamp<=?2 GROUP BY app_id ORDER BY app_id")?;
        let apps=stmt.query_map(params![start,end],|r|{
            let name:Option<String>=r.get(1)?;
            Ok(json!({"id":r.get::<_,String>(0)?,"name":name.as_deref().unwrap_or("Unattributed"),"bundleId":r.get::<_,Option<String>>(2)?,"attributed":name.is_some(),"words":r.get::<_,i64>(3)?,"seconds":r.get::<_,f64>(4)?,"sessions":r.get::<_,i64>(5)?,"lastUsedAt":r.get::<_,i64>(6)?,"processingMs":r.get::<_,f64>(7)?,"local":r.get::<_,i64>(8)?}))
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut timeline = Vec::new();
        for b in buckets {
            let (w,n):(i64,i64)=self.conn.query_row("SELECT COALESCE(SUM(words),0),COUNT(*) FROM transcripts WHERE timestamp>=?1 AND timestamp<?2 AND timestamp<=?3",params![b.timestamp.max(start),b.end,end],|r|Ok((r.get(0)?,r.get(1)?)))?;
            timeline.push(json!({"timestamp":b.timestamp,"label":b.label,"fullLabel":b.full_label,"words":w,"sessions":n}));
        }
        let mut engines = Vec::new();
        for engine in ["local", "cloud"] {
            let (n,w):(i64,i64)=self.conn.query_row("SELECT COUNT(*),COALESCE(SUM(words),0) FROM transcripts WHERE engine=?1 AND timestamp>=?2 AND timestamp<=?3",params![engine,start,end],|r|Ok((r.get(0)?,r.get(1)?)))?;
            let changes:i64=self.conn.query_row("SELECT COALESCE(SUM(c.changes),0) FROM corrections c JOIN transcripts t ON t.id=c.transcript_id WHERE t.engine=?1 AND t.timestamp>=?2 AND t.timestamp<=?3",params![engine,start,end],|r|r.get(0))?;
            engines.push(json!({"engine":engine,"sessions":n,"share":if sessions>0{Some((n as f64/sessions as f64*100.0).round())}else{None},"rate":rate(changes,w)}));
        }
        let recent=payloads(&self.conn,"SELECT payload FROM transcripts WHERE timestamp>=?1 AND timestamp<=?2 ORDER BY timestamp DESC,id DESC LIMIT 5",params![start,end])?;
        Ok(
            json!({"stats":summary["stats"],"timing":summary["timing"],"activeDays":summary["activeDays"],"applications":apps,"timeline":timeline,"recent":recent,"engines":engines}),
        )
    }
    pub fn export(&self, path: &Path, now: i64) -> Result<i64> {
        let parent = path.parent().ok_or("Invalid export location")?;
        let temp = parent.join(format!(".linty-export-{}-{}.tmp", std::process::id(), now));
        let result = (|| -> Result<i64> {
            let file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            let mut out = BufWriter::new(file);
            write!(
                out,
                "{{\"formatVersion\":1,\"exportedAt\":{now},\"transcripts\":["
            )?;
            let mut count = 0;
            for (index, table) in ["transcripts", "corrections"].iter().enumerate() {
                if index == 1 {
                    write!(out, "],\"corrections\":[")?;
                }
                let mut stmt = self.conn.prepare(&format!(
                    "SELECT payload FROM {table} ORDER BY timestamp DESC,id DESC"
                ))?;
                let mut rows = stmt.query([])?;
                let mut first = true;
                while let Some(row) = rows.next()? {
                    if !first {
                        out.write_all(b",")?;
                    }
                    first = false;
                    out.write_all(row.get::<_, String>(0)?.as_bytes())?;
                    if index == 0 {
                        count += 1;
                    }
                }
            }
            out.write_all(b"]}\n")?;
            out.flush()?;
            out.get_ref().sync_all()?;
            fs::rename(&temp, path)?;
            Ok(count)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }
}
fn rate(changes: i64, words: i64) -> Option<f64> {
    if words > 0 {
        Some((changes as f64 / words as f64 * 1000.0).round() / 10.0)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "linty-history-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn record(id: usize, time: i64) -> Value {
        json!({"transcriptId":format!("t-{id:05}"),"timestamp":time,"finalText":format!("Private example {id}"),"rawText":"Original","wordCount":20,"durationSeconds":10,"processingTimeMs":1000,"engine":"local","modelName":"test","corrected":false,"application":{"name":"Éditeur","bundleId":"com.example.editor"},"futureField":{"keep":true}})
    }
    fn correction(id: usize, time: i64) -> Value {
        json!({"correctionId":format!("c-{id}"),"transcriptId":format!("t-{id:05}"),"timestamp":time,"rewrite":false,"pairs":[{"from":"exampel","to":"example","kind":"substitution"}]})
    }
    fn legacy(dir: &Path, records: Vec<Value>, corrections: Vec<Value>) {
        fs::write(
            dir.join(LEGACY[0].0),
            serde_json::to_vec(&json!({"transcripts":records})).unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join(LEGACY[1].0),
            serde_json::to_vec(&json!({"corrections":corrections})).unwrap(),
        )
        .unwrap();
    }
    fn audio(epoch: i64) -> PendingAudio {
        PendingAudio {
            generation: 7,
            consent_epoch: epoch,
            samples: Arc::new(vec![0.0, 0.5, -0.5, 1.0]),
        }
    }
    #[test]
    fn streamed_reads_exports_and_stats_remain_correct_across_reopen() {
        let dir = Temp::new();
        let mut db = HistoryDb::open(&dir.0).unwrap();
        db.set_save_audio(true, 1).unwrap();
        let audio = PendingAudio {
            generation: 1,
            consent_epoch: db.audio_consent().unwrap().unwrap(),
            samples: Arc::new(vec![0.25; AUDIO_READ_LIMIT + 13]),
        };
        let expected = crate::transcribe::encode_wav(&audio.samples);
        db.save_with_audio(&record(1, 100), 200, Some(&audio))
            .unwrap();
        // Re-saving cannot replace an attachment or double-count its storage.
        db.save_with_audio(&record(1, 100), 200, Some(&audio))
            .unwrap();
        assert_eq!(db.snapshot().unwrap()["audioCount"], 1);
        assert_eq!(db.snapshot().unwrap()["audioBytes"], expected.len());
        let mut actual = Vec::new();
        while actual.len() < expected.len() {
            actual.extend(
                db.audio_chunk("t-00001", actual.len() as u64, AUDIO_READ_LIMIT)
                    .unwrap(),
            );
        }
        assert_eq!(actual, expected);
        assert!(db.audio_chunk("t-00001", 0, AUDIO_READ_LIMIT + 1).is_err());
        assert!(db.audio_chunk("t-00001", u64::MAX, 1).is_err());
        assert!(db.audio_chunk("t-00001", 0, 0).is_err());
        let mut exported = Vec::new();
        assert_eq!(
            db.copy_audio("t-00001", &mut exported).unwrap(),
            expected.len() as u64
        );
        assert_eq!(exported, expected);
        // Simulate an archive created before the aggregate cache was added.
        db.conn
            .execute("DELETE FROM audio_storage_stats", [])
            .unwrap();
        drop(db);
        let mut db = HistoryDb::open(&dir.0).unwrap();
        assert_eq!(db.snapshot().unwrap()["audioBytes"], expected.len());
        db.delete("t-00001").unwrap();
        assert_eq!(db.snapshot().unwrap()["audioBytes"], 0);
        assert_eq!(db.snapshot().unwrap()["audioCount"], 0);
        assert!(db.audio_chunk("t-00001", 0, 44).is_err());
    }
    #[test]
    fn audio_requires_consent_and_old_consent_cannot_be_reused() {
        let dir = Temp::new();
        let mut db = HistoryDb::open(&dir.0).unwrap();
        assert_eq!(db.audio_consent().unwrap(), None);
        // A frontend request/metadata cannot opt the user in.
        let mut forged = record(1, 100);
        forged["audio"] = json!({"bytes":999});
        db.save_with_audio(&forged, 200, Some(&audio(0))).unwrap();
        assert!(db.audio("t-00001").unwrap().is_none());
        assert!(db.get("t-00001").unwrap().unwrap()["audio"].is_null());
        db.set_save_audio(true, 200).unwrap();
        let consent = db.audio_consent().unwrap().unwrap();
        let captured = audio(consent);
        db.save_with_audio(&record(2, 201), 202, Some(&captured))
            .unwrap();
        assert_eq!(
            db.audio("t-00002").unwrap(),
            Some(crate::transcribe::encode_wav(&captured.samples))
        );
        db.set_save_audio(false, 203).unwrap();
        db.save_with_audio(&record(3, 204), 205, Some(&captured))
            .unwrap();
        assert!(db.audio("t-00003").unwrap().is_none());
        db.set_save_audio(true, 206).unwrap();
        db.save_with_audio(&record(4, 207), 208, Some(&captured))
            .unwrap();
        assert!(db.audio("t-00004").unwrap().is_none());
        drop(db);
        let db = HistoryDb::open(&dir.0).unwrap();
        assert!(db.audio_consent().unwrap().is_some());
        assert!(
            db.audio("t-00002").unwrap().is_some(),
            "Turning off saving keeps existing audio"
        );
        assert_eq!(db.snapshot().unwrap()["audioCount"], 1);
    }
    #[test]
    fn audio_and_transcript_are_atomic_and_metadata_survives_edits() {
        let dir = Temp::new();
        let mut db = HistoryDb::open(&dir.0).unwrap();
        db.set_save_audio(true, 100).unwrap();
        let audio = audio(db.audio_consent().unwrap().unwrap());
        db.conn.execute_batch("CREATE TRIGGER fail_audio BEFORE INSERT ON transcript_audio BEGIN SELECT RAISE(ABORT,'Disk failure'); END;").unwrap();
        assert!(db
            .save_with_audio(&record(1, 100), 200, Some(&audio))
            .is_err());
        assert!(db.get("t-00001").unwrap().is_none());
        db.conn.execute_batch("DROP TRIGGER fail_audio;").unwrap();
        db.save_with_audio(&record(1, 100), 200, Some(&audio))
            .unwrap();
        db.patch("t-00001", &json!({"finalText":"Edited reference"}))
            .unwrap();
        let record = db.get("t-00001").unwrap().unwrap();
        assert_eq!(record["audio"], audio_metadata(52));
        assert_eq!(record["rawText"], "Original");
        assert_eq!(record["finalText"], "Edited reference");
        assert_eq!(db.snapshot().unwrap()["audioBytes"], 52);
        // Playback/export receives a complete standard 16 kHz mono PCM16 WAV.
        let wav = db.audio("t-00001").unwrap().unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16000);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
        assert_eq!(wav.len(), 52);
    }
    #[test]
    fn audio_deletion_is_permanent_even_when_text_deletion_is_undone() {
        let dir = Temp::new();
        let mut db = HistoryDb::open(&dir.0).unwrap();
        db.set_save_audio(true, 100).unwrap();
        let audio = audio(db.audio_consent().unwrap().unwrap());
        for i in 1..=3 {
            db.save_with_audio(&record(i, 100), 200, Some(&audio))
                .unwrap();
        }
        db.delete_audio(Some("t-00001")).unwrap();
        assert!(db.audio("t-00001").unwrap().is_none());
        assert!(db.get("t-00001").unwrap().unwrap()["audio"].is_null());
        assert!(db.audio("t-00002").unwrap().is_some());
        let deleted = db.delete("t-00002").unwrap().unwrap();
        assert!(deleted.transcript["audio"].is_object());
        assert!(db.audio("t-00002").unwrap().is_none());
        db.restore(&deleted, 200).unwrap();
        assert!(db.get("t-00002").unwrap().unwrap()["audio"].is_null());
        db.delete_audio(None).unwrap();
        assert_eq!(db.snapshot().unwrap()["audioCount"], 0);
        assert_eq!(db.snapshot().unwrap()["total"], 3);
        db.save_with_audio(&record(4, 100), 200, Some(&audio))
            .unwrap();
        assert!(
            db.audio("t-00004").unwrap().is_none(),
            "Erasing all audio invalidates in-flight captures"
        );
    }
    #[test]
    fn daily_cleanup_survives_reopen_and_removes_all_related_assets() {
        let dir = Temp::new();
        let now = 100 * CLEANUP_INTERVAL_MS;
        let mut db = HistoryDb::open(&dir.0).unwrap();
        assert_eq!(db.cleanup_due_at().unwrap(), None);
        db.set_save_audio(true, now).unwrap();
        let audio = audio(db.audio_consent().unwrap().unwrap());
        let expiring = now - 30 * CLEANUP_INTERVAL_MS + 3_600_000;
        db.save_with_audio(&record(1, expiring), now, Some(&audio))
            .unwrap();
        db.add_correction(&correction(1, expiring)).unwrap();
        db.save_with_audio(&record(2, now), now, Some(&audio))
            .unwrap();
        db.set_retention(30, now).unwrap();
        assert_eq!(
            db.cleanup_due_at().unwrap(),
            Some(now + CLEANUP_INTERVAL_MS)
        );
        assert!(!db.prune(now + 3_600_001).unwrap());
        assert!(db.audio("t-00001").unwrap().is_some());
        drop(db);

        let mut db = HistoryDb::open(&dir.0).unwrap();
        assert!(!db.prune(now + CLEANUP_INTERVAL_MS - 1).unwrap());
        assert!(db.prune(now + CLEANUP_INTERVAL_MS).unwrap());
        assert!(db.get("t-00001").unwrap().is_none());
        assert!(db.corrections("t-00001").unwrap().is_empty());
        assert!(db.audio_chunk("t-00001", 0, 44).is_err());
        assert_eq!(db.snapshot().unwrap()["audioCount"], 1);
        assert_eq!(db.snapshot().unwrap()["audioBytes"], 52);
        assert_eq!(db.snapshot().unwrap()["correctionCount"], 0);
        assert!(!db.prune(now + CLEANUP_INTERVAL_MS + 1).unwrap());
        // Manual deletion still removes audio immediately during the daily gate.
        db.delete("t-00002").unwrap();
        assert_eq!(db.snapshot().unwrap()["audioBytes"], 0);
    }

    #[test]
    fn failed_daily_cleanup_rolls_back_audio_text_and_schedule() {
        let dir = Temp::new();
        let now = 100 * CLEANUP_INTERVAL_MS;
        let mut db = HistoryDb::open(&dir.0).unwrap();
        db.set_save_audio(true, now).unwrap();
        let audio = audio(db.audio_consent().unwrap().unwrap());
        db.save_with_audio(&record(1, now), now, Some(&audio))
            .unwrap();
        db.add_correction(&correction(1, now)).unwrap();
        db.set_retention(30, now).unwrap();
        let due = db.cleanup_due_at().unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_delete BEFORE DELETE ON transcript_audio BEGIN SELECT RAISE(ABORT,'Disk failure'); END;").unwrap();
        assert!(db.prune(now + 31 * CLEANUP_INTERVAL_MS).is_err());
        assert_eq!(db.cleanup_due_at().unwrap(), due);
        assert!(db.get("t-00001").unwrap().is_some());
        assert!(db.audio("t-00001").unwrap().is_some());
        assert_eq!(db.corrections("t-00001").unwrap().len(), 1);
        db.conn.execute_batch("DROP TRIGGER fail_delete;").unwrap();
        assert!(db.prune(now + 31 * CLEANUP_INTERVAL_MS).unwrap());
        assert_eq!(db.snapshot().unwrap()["audioBytes"], 0);
    }

    #[test]
    fn retention_clear_and_reset_remove_audio_with_history() {
        let dir = Temp::new();
        let mut db = HistoryDb::open(&dir.0).unwrap();
        let now = 100 * 86_400_000;
        db.set_save_audio(true, now).unwrap();
        let audio = audio(db.audio_consent().unwrap().unwrap());
        db.save_with_audio(&record(1, 1), now, Some(&audio))
            .unwrap();
        db.save_with_audio(&record(2, now), now, Some(&audio))
            .unwrap();
        db.set_retention(30, now).unwrap();
        assert!(db.audio("t-00001").unwrap().is_none());
        assert!(db.audio("t-00002").unwrap().is_some());
        db.prune(now + 31 * 86_400_000).unwrap();
        assert!(db.audio("t-00002").unwrap().is_none());
        db.save_with_audio(&record(3, now), now, Some(&audio))
            .unwrap();
        db.clear().unwrap();
        assert_eq!(db.snapshot().unwrap()["audioCount"], 0);
        db.save_with_audio(&record(4, now), now, Some(&audio))
            .unwrap();
        assert!(db.audio("t-00004").unwrap().is_none());
        drop(db);
        fs::remove_file(dir.0.join(DATABASE)).unwrap();
        let db = HistoryDb::open(&dir.0).unwrap();
        assert_eq!(db.audio_consent().unwrap(), None);
        assert_eq!(db.snapshot().unwrap()["audioCount"], 0);
    }
    #[test]
    fn migration_preserves_more_than_500_and_is_idempotent() {
        let dir = Temp::new();
        let records = (0..1205).map(|i| record(i, i as i64 + 1)).collect();
        legacy(&dir.0, records, vec![correction(1, 2)]);
        {
            let db = HistoryDb::open(&dir.0).unwrap();
            let snapshot = db.snapshot().unwrap();
            assert_eq!(snapshot["total"], 1205);
            assert_eq!(snapshot["recent"].as_array().unwrap().len(), 20);
            assert_eq!(
                db.get("t-00001").unwrap().unwrap()["futureField"]["keep"],
                true
            );
            assert_eq!(db.corrections("t-00001").unwrap().len(), 1);
            assert_eq!(db.retention().unwrap(), 0);
        }
        assert!(!dir.0.join(LEGACY[0].0).exists());
        assert!(!dir.0.join(LEGACY[1].0).exists());
        let db = HistoryDb::open(&dir.0).unwrap();
        assert_eq!(db.snapshot().unwrap()["total"], 1205);
    }
    #[test]
    fn committed_migration_never_reimports_leftover_legacy_copies() {
        let dir = Temp::new();
        legacy(&dir.0, vec![record(1, 1)], vec![correction(1, 2)]);
        let mut db = HistoryDb::open(&dir.0).unwrap();
        db.delete("t-00001").unwrap();
        drop(db);
        // Simulate legacy copies left after the migration transaction committed.
        legacy(&dir.0, vec![record(1, 1)], vec![correction(1, 2)]);
        let db = HistoryDb::open(&dir.0).unwrap();
        assert_eq!(db.snapshot().unwrap()["total"], 0);
        assert!(db.corrections("t-00001").unwrap().is_empty());
        assert!(!dir.0.join(LEGACY[0].0).exists());
        assert!(!dir.0.join(LEGACY[1].0).exists());
    }
    #[test]
    fn oldest_record_format_receives_metadata_defaults_without_losing_text() {
        let dir = Temp::new();
        let original =
            json!({"transcriptId":"legacy","timestamp":1,"finalText":"Keep this.","unknown":42});
        legacy(&dir.0, vec![original.clone()], vec![]);
        let db = HistoryDb::open(&dir.0).unwrap();
        let migrated = db.get("legacy").unwrap().unwrap();
        for (key, value) in original.as_object().unwrap() {
            assert_eq!(&migrated[key], value);
        }
        assert_eq!(migrated["rawText"], "Keep this.");
        assert_eq!(migrated["wordCount"], 2);
        assert_eq!(migrated["engine"], "local");
        assert_eq!(db.snapshot().unwrap()["totalWords"], 2);
    }
    #[test]
    fn failed_migration_rolls_back_everything_and_keeps_originals() {
        let dir = Temp::new();
        legacy(
            &dir.0,
            vec![record(1, 1)],
            vec![json!({"correctionId":"bad"})],
        );
        assert!(HistoryDb::open(&dir.0).is_err());
        assert!(dir.0.join(LEGACY[0].0).exists());
        assert!(dir.0.join(LEGACY[1].0).exists());
        let conn = Connection::open(dir.0.join(DATABASE)).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM transcripts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        fs::write(dir.0.join(LEGACY[1].0), r#"{"corrections":[]}"#).unwrap();
        assert_eq!(
            HistoryDb::open(&dir.0).unwrap().snapshot().unwrap()["total"],
            1
        );
    }
    #[test]
    fn malformed_or_duplicate_legacy_history_is_not_silently_discarded() {
        let dir = Temp::new();
        fs::write(dir.0.join(LEGACY[0].0), "{broken").unwrap();
        assert!(HistoryDb::open(&dir.0).is_err());
        assert_eq!(
            fs::read_to_string(dir.0.join(LEGACY[0].0)).unwrap(),
            "{broken"
        );
        legacy(&dir.0, vec![record(1, 1), record(1, 1)], vec![]);
        assert!(HistoryDb::open(&dir.0).is_err());
        assert!(dir.0.join(LEGACY[0].0).exists());
    }
    #[test]
    fn pagination_search_and_aggregates_cover_full_archive() {
        let dir = Temp::new();
        legacy(
            &dir.0,
            (0..1205).map(|i| record(i, 100)).collect(),
            vec![correction(1, 101)],
        );
        let db = HistoryDb::open(&dir.0).unwrap();
        let page1 = db.query("", 0, 50).unwrap();
        let page2 = db.query("", 50, 50).unwrap();
        assert_eq!(page1["total"], 1205);
        assert_eq!(page1["records"].as_array().unwrap().len(), 50);
        assert_eq!(page1["records"][49]["transcriptId"], "t-01155");
        assert_eq!(page2["records"][0]["transcriptId"], "t-01154");
        assert_eq!(db.query(" ÉDITEUR ", 0, 50).unwrap()["total"], 1205);
        assert_eq!(db.query("example 1204", 0, 50).unwrap()["total"], 1);
        assert_eq!(db.query("%", 0, 50).unwrap()["total"], 0);
        let usage = db
            .usage(
                0,
                200,
                &[Bucket {
                    timestamp: 0,
                    end: 201,
                    label: "Today".into(),
                    full_label: "Today".into(),
                }],
            )
            .unwrap();
        assert_eq!(usage["stats"]["words"], 24100);
        assert_eq!(usage["stats"]["sessions"], 1205);
        assert_eq!(usage["applications"][0]["words"], 24100);
        assert_eq!(usage["timeline"][0]["sessions"], 1205);
        assert_eq!(usage["recent"].as_array().unwrap().len(), 5);
        assert_eq!(db.usage(101, 200, &[]).unwrap()["stats"]["sessions"], 0);
    }
    #[test]
    fn deletion_undo_and_edits_preserve_other_records_and_statistics() {
        let dir = Temp::new();
        let mut db = HistoryDb::open(&dir.0).unwrap();
        db.save(&record(1, 100), 200).unwrap();
        db.add_correction(&correction(1, 101)).unwrap();
        let deleted = db.delete("t-00001").unwrap().unwrap();
        assert_eq!(db.snapshot().unwrap()["total"], 0);
        assert!(db.corrections("t-00001").unwrap().is_empty());
        db.save(&record(2, 102), 200).unwrap();
        db.restore(&deleted, 200).unwrap();
        db.restore(&deleted, 200).unwrap();
        assert_eq!(db.snapshot().unwrap()["total"], 2);
        assert_eq!(db.corrections("t-00001").unwrap().len(), 1);
        db.patch("t-00001", &json!({"finalText":"Entirely edited"}))
            .unwrap();
        assert_eq!(db.query("Entirely edited", 0, 50).unwrap()["total"], 1);
        assert_eq!(db.snapshot().unwrap()["totalWords"], 40);
        db.restore(&deleted, 200).unwrap();
        assert_eq!(
            db.get("t-00001").unwrap().unwrap()["finalText"],
            "Entirely edited"
        );
        db.clear().unwrap();
        assert!(db.restore(&deleted, 200).is_err());
        assert_eq!(db.snapshot().unwrap()["total"], 0);
    }
    #[test]
    fn retention_is_optional_persistent_and_prunes_related_corrections() {
        let dir = Temp::new();
        let now = 100 * 86_400_000;
        let mut db = HistoryDb::open(&dir.0).unwrap();
        db.save(&record(1, 1), now).unwrap();
        db.save(&record(2, now), now).unwrap();
        db.add_correction(&correction(1, 2)).unwrap();
        db.prune(now).unwrap();
        assert_eq!(db.snapshot().unwrap()["total"], 2);
        assert_eq!(db.retention_preview(30, now).unwrap(), 1);
        assert_eq!(db.retention_preview(0, now).unwrap(), 0);
        assert!(db.set_retention(3, now).is_err());
        db.set_retention(30, now).unwrap();
        assert_eq!(db.snapshot().unwrap()["total"], 1);
        assert!(db.corrections("t-00001").unwrap().is_empty());
        assert!(db.save(&record(1, 1), now).is_err());
        drop(db);
        let mut db = HistoryDb::open(&dir.0).unwrap();
        assert_eq!(db.retention().unwrap(), 30);
        db.prune(now + 31 * 86_400_000).unwrap();
        assert_eq!(db.snapshot().unwrap()["total"], 0);
    }
    #[test]
    fn pipeline_updates_never_resurrect_deleted_text_or_overwrite_user_edits() {
        let dir = Temp::new();
        let mut db = HistoryDb::open(&dir.0).unwrap();
        let mut original = record(1, 100);
        original["deliveryStatus"] = json!("pending");
        db.save(&original, 100).unwrap();
        db.patch("t-00001", &json!({"finalText":"My manual edit"}))
            .unwrap();
        let mut completion = original.clone();
        completion["finalText"] = json!("Automatic output");
        completion["rawText"] = json!("Must not overwrite original");
        completion["deliveryStatus"] = json!("verified");
        completion["pastedText"] = json!("Automatic output");
        db.update_pipeline("t-00001", &completion).unwrap();
        let saved = db.get("t-00001").unwrap().unwrap();
        assert_eq!(saved["finalText"], "My manual edit");
        assert_eq!(saved["rawText"], original["rawText"]);
        assert_eq!(saved["pastedText"], "Automatic output");
        db.delete("t-00001").unwrap();
        assert!(db.update_pipeline("t-00001", &completion).is_err());
        assert!(db.get("t-00001").unwrap().is_none());
    }
    #[test]
    fn payoff_summary_uses_only_complete_timing_and_counts_distinct_days() {
        let dir = Temp::new();
        let mut db = HistoryDb::open(&dir.0).unwrap();
        db.save(&record(1, 43_200_000), 300_000_000).unwrap();
        db.save(&record(2, 129_600_000), 300_000_000).unwrap();
        let mut legacy = record(3, 43_200_001);
        legacy["durationSeconds"] = json!(0);
        legacy["wordCount"] = json!(500);
        db.save(&legacy, 300_000_000).unwrap();
        db.save(&record(4, 400_000_000), 300_000_000).unwrap();
        let summary = db.usage_summary(0, 300_000_000).unwrap();
        assert_eq!(summary["stats"]["words"], 540);
        assert_eq!(summary["timing"]["words"], 40);
        assert_eq!(summary["timing"]["seconds"], 20.0);
        assert_eq!(summary["timing"]["processingSeconds"], 2.0);
        assert_eq!(summary["timing"]["missingSessions"], 1);
        assert_eq!(summary["activeDays"], 2);
        assert_eq!(
            db.usage(0, 300_000_000, &[]).unwrap()["timing"],
            summary["timing"]
        );
    }
    #[test]
    fn milestone_date_comes_from_retained_words_and_changes_after_deletion() {
        let dir = Temp::new();
        let mut db = HistoryDb::open(&dir.0).unwrap();
        for (id, time, words) in [(1, 10, 600), (2, 20, 1400), (3, 30, 8500)] {
            let mut r = record(id, time);
            r["wordCount"] = json!(words);
            db.save(&r, 100).unwrap();
        }
        assert_eq!(
            db.snapshot().unwrap()["milestone"],
            json!({"words":10000,"timestamp":30})
        );
        db.delete("t-00003").unwrap();
        assert_eq!(
            db.snapshot().unwrap()["milestone"],
            json!({"words":1000,"timestamp":20})
        );
        db.delete("t-00002").unwrap();
        assert!(db.snapshot().unwrap()["milestone"].is_null());
    }
    #[test]
    fn export_contains_every_record_and_correction_without_changing_archive() {
        let dir = Temp::new();
        legacy(
            &dir.0,
            (0..605).map(|i| record(i, i as i64)).collect(),
            vec![correction(1, 1)],
        );
        let db = HistoryDb::open(&dir.0).unwrap();
        let path = dir.0.join("export.json");
        assert_eq!(db.export(&path, 999).unwrap(), 605);
        let exported: Value = serde_json::from_reader(fs::File::open(path).unwrap()).unwrap();
        assert_eq!(exported["transcripts"].as_array().unwrap().len(), 605);
        assert_eq!(exported["corrections"].as_array().unwrap().len(), 1);
        assert_eq!(exported["transcripts"][0]["futureField"]["keep"], true);
        assert_eq!(db.snapshot().unwrap()["total"], 605);
    }

    #[test]
    fn reformatting_snapshots_and_metrics_survive_edit_reopen_restore_and_export() {
        let dir = Temp::new();
        let mut db = HistoryDb::open(&dir.0).unwrap();
        let mut original = record(1, 100);
        original["rawText"] = json!("um send this friday no monday");
        original["reformattedText"] = json!("Send this Monday.");
        original["pastedText"] = json!("Send this Monday.");
        original["finalText"] = json!("Send this Monday.");
        original["reformatting"] = json!({"schemaVersion":1,"enabled":true,"status":"applied","totalMs":321.5,"modelRevision":"pinned","generatedTokens":5,"options":{"styling":"semi-formal","structure":"lists","context":"general"}});
        db.save(&original, 100).unwrap();
        db.patch("t-00001", &json!({"finalText":"Send this Monday, please.","rawText":"must not overwrite","reformatting":null})).unwrap();
        let deleted = db.delete("t-00001").unwrap().unwrap();
        db.restore(&deleted, 100).unwrap();
        drop(db);
        let db = HistoryDb::open(&dir.0).unwrap();
        let saved = db.get("t-00001").unwrap().unwrap();
        for key in ["rawText", "reformattedText", "pastedText", "reformatting"] {
            assert_eq!(saved[key], original[key]);
        }
        assert_eq!(saved["finalText"], "Send this Monday, please.");
        let path = dir.0.join("reformat-export.json");
        db.export(&path, 100).unwrap();
        let exported: Value = serde_json::from_reader(fs::File::open(path).unwrap()).unwrap();
        assert_eq!(exported["transcripts"][0], saved);
    }
}
