//! Pure editing-session state. No AX, app handles, persistence, or notifications.
use super::diff::{span_edits, words};
use super::{ObservedApplication, ObservedCorrection};
use std::collections::VecDeque;
use std::ops::Range;
use std::time::{Duration, Instant};

pub(super) const INPUT_SETTLE: Duration = Duration::from_millis(80);
#[derive(Clone, Default)]
pub(super) struct InputState {
    pub revision: u64,
    pub edited_at: Option<Instant>,
    pub submit: Option<(Instant, u64)>,
}
impl InputState {
    pub fn key_down(&mut self, key: u16, shift: bool, command: bool, at: Instant) {
        if key == 48 && command {
            return;
        } // Cmd+Tab changes apps, not text.
        if matches!(key, 36 | 76) && !shift {
            self.submit = Some((at, self.revision));
        } else {
            self.revision += 1;
            self.edited_at = Some(at);
            // Do not erase a Return that the observer has not processed yet.
        }
    }
}

/// Pure session state: the original is never replaced by an intermediate edit.
/// Tracking input revisions prevents a stale pre-submit read from being learned.
pub(super) struct PendingCorrection {
    pub latest: String,
    pub revision: Option<u64>,
    verified: VecDeque<VerifiedRead>,
}
#[derive(Clone)]
struct VerifiedRead {
    text: String,
    revision: u64,
    completed: Instant,
}
impl PendingCorrection {
    pub fn new(latest: String) -> Self {
        Self {
            latest,
            revision: None,
            verified: VecDeque::new(),
        }
    }
    pub fn update(
        &mut self,
        value: String,
        before: &InputState,
        after: &InputState,
        now: Instant,
        completed: Instant,
    ) {
        self.latest = value;
        self.revision = (before.revision == after.revision
            && after.edited_at.is_none_or(|at| {
                now.checked_duration_since(at)
                    .is_some_and(|elapsed| elapsed >= INPUT_SETTLE)
            }))
        .then_some(after.revision);
        if let Some(revision) = self.revision {
            self.verified.push_back(VerifiedRead {
                text: self.latest.clone(),
                revision,
                completed,
            });
            if self.verified.len() > 16 {
                self.verified.pop_front();
            }
        }
    }
    pub fn fresh(&self, input: &InputState) -> bool {
        self.revision == Some(input.revision)
    }
    fn before_submit(&self, input: &InputState, now: Instant) -> Option<VerifiedRead> {
        let (at, revision) = input.submit?;
        if input.revision != revision || now.checked_duration_since(at)? > Duration::from_secs(1) {
            return None;
        }
        // Use the actual key event time, not when NSEvent delivered its callback.
        // A read begun before Return but completed after it is also excluded.
        self.verified
            .iter()
            .rev()
            .find(|read| read.revision == revision && read.completed <= at)
            .cloned()
    }
    fn invalidate(&mut self) {
        self.revision = None;
        self.verified.clear();
    }
}

struct Insertion {
    transcript_id: String,
    pasted: String,
    base: Vec<String>,
    span: Range<usize>,
}

pub(super) struct EditingSession {
    insertions: Vec<Insertion>,
    pub pending: PendingCorrection,
    pub started: Instant,
    departed: Option<Instant>,
    misses: usize,
    consumed_submit: Option<Instant>,
    submitted: Option<(Instant, VerifiedRead)>,
}
impl EditingSession {
    pub fn new(value: String) -> Self {
        Self {
            insertions: Vec::new(),
            pending: PendingCorrection::new(value),
            started: Instant::now(),
            departed: None,
            misses: 0,
            consumed_submit: None,
            submitted: None,
        }
    }
    /// Verify the actual replacement of the pre-paste selection. No document-wide
    /// search can accidentally attach a repeated phrase to the wrong occurrence.
    pub fn insert(
        &mut self,
        transcript_id: String,
        pasted: String,
        before: &str,
        selection: Range<usize>,
        after: String,
    ) -> bool {
        if self.insertions.len() >= 16 {
            return false;
        }
        let Some(span) = insertion_span(before, selection.clone(), &pasted, &after) else {
            return false;
        };
        // Appending continues the draft. Inserting over or inside earlier text
        // invalidates its attribution: never learn Linty's own new dictation as
        // a correction of an earlier one.
        if selection.start != selection.end || selection.end != before.encode_utf16().count() {
            self.insertions.clear();
        }
        self.insertions.push(Insertion {
            transcript_id,
            pasted,
            base: words(&after),
            span,
        });
        self.pending = PendingCorrection::new(after);
        self.submitted = None;
        self.departed = None;
        true
    }
    pub fn observe(&mut self, snapshot: Snapshot) -> Outcome {
        let Snapshot {
            value,
            focused,
            composing,
            before,
            after,
            read_started,
            now,
            can_submit,
        } = snapshot;
        if now.duration_since(self.started) >= Duration::from_secs(120) {
            return Outcome::Discard;
        }
        if focused == Some(false) {
            self.departed.get_or_insert(now);
        } else {
            self.departed = None;
        }
        if composing {
            self.pending.invalidate();
            if self.submitted.is_some() {
                return Outcome::Discard;
            }
            return Outcome::Continue;
        }
        if can_submit {
            if let Some((at, _)) = after
                .submit
                .filter(|(at, _)| self.consumed_submit.is_none_or(|seen| *at > seen))
            {
                self.consumed_submit = Some(at);
                let Some(read) = self.pending.before_submit(&after, now) else {
                    return Outcome::Discard;
                };
                self.pending.latest = read.text.clone();
                self.pending.revision = Some(read.revision);
                self.submitted = Some((at, read));
            }
        }
        if let Some((at, submitted)) = &self.submitted {
            if after.revision != submitted.revision {
                return Outcome::Discard;
            }
            let Some(current) = &value else {
                return Outcome::Discard;
            };
            // A read racing Return cannot confirm what the application did.
            if read_started < *at {
                return Outcome::Continue;
            }
            let newline = current.matches('\n').count() > submitted.text.matches('\n').count()
                && words(current) == words(&submitted.text);
            if newline && focused == Some(true) {
                // Return inserted a line break. Continue the same editing
                // session, and never reuse this key as a later submit signal.
                self.submitted = None;
                self.pending
                    .update(current.clone(), &before, &after, read_started, now);
                return Outcome::Continue;
            } else if current != &submitted.text {
                // Clear, navigation URL, confirmation text, or a new draft:
                // none of this post-submit value belongs to the dictated draft.
                return Outcome::Finish;
            } else if self
                .departed
                .is_some_and(|at| now.duration_since(at) >= Duration::from_millis(250))
            {
                return Outcome::Finish;
            } else {
                return Outcome::Continue;
            }
        }
        match value {
            Some(value) if value.trim().is_empty() => Outcome::Discard,
            Some(value) => {
                self.misses = 0;
                // Once focus leaves, a changed value may belong to the host's
                // next screen. Validate the draft; never overwrite it on blur.
                if focused != Some(true) {
                    if value != self.pending.latest || !self.pending.fresh(&after) {
                        return Outcome::Discard;
                    }
                } else {
                    if can_submit && value != self.pending.latest && self.pending.fresh(&after) {
                        // A host-driven mutation without a new edit revision
                        // cannot be attributed to the user (even if focus stays).
                        return Outcome::Discard;
                    }
                    self.pending
                        .update(value, &before, &after, read_started, now);
                }
                if self
                    .departed
                    .is_some_and(|at| now.duration_since(at) >= Duration::from_millis(250))
                    && self.pending.fresh(&after)
                {
                    Outcome::Finish
                } else {
                    Outcome::Continue
                }
            }
            None => {
                self.pending.invalidate();
                self.misses += 1;
                if self.misses >= 3 {
                    Outcome::Discard
                } else {
                    Outcome::Continue
                }
            }
        }
    }
    pub fn finish(self, application: ObservedApplication) -> Vec<ObservedCorrection> {
        let after = words(&self.pending.latest);
        self.insertions
            .into_iter()
            .filter_map(|insertion| {
                let pairs = span_edits(&insertion.base, &after, &insertion.span);
                (!pairs.is_empty()).then(|| ObservedCorrection {
                    transcript_id: insertion.transcript_id,
                    word_count: words(&insertion.pasted).len(),
                    application: application.clone(),
                    pairs,
                    seconds_after_paste: self.started.elapsed().as_secs(),
                })
            })
            .collect()
    }
}

pub(super) struct Snapshot {
    pub value: Option<String>,
    pub focused: Option<bool>,
    pub composing: bool,
    pub before: InputState,
    pub after: InputState,
    pub read_started: Instant,
    pub now: Instant,
    pub can_submit: bool,
}
#[derive(Debug, PartialEq)]
pub(super) enum Outcome {
    Continue,
    Finish,
    Discard,
}

fn utf16_byte(text: &str, offset: usize) -> Option<usize> {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units == offset {
            return Some(byte);
        }
        units += ch.len_utf16();
    }
    (units == offset).then_some(text.len())
}
fn insertion_span(
    before: &str,
    selection: Range<usize>,
    pasted: &str,
    after: &str,
) -> Option<Range<usize>> {
    if selection.start > selection.end {
        return None;
    }
    let start = utf16_byte(before, selection.start)?;
    let end = utf16_byte(before, selection.end)?;
    let prefix = &before[..start];
    let suffix = &before[end..];
    let inserted = after.strip_prefix(prefix)?.strip_suffix(suffix)?;
    // Permit surrounding spacing added by a host, but never changed letters.
    if words(inserted) != words(pasted) || words(pasted).is_empty() {
        return None;
    }
    if prefix.chars().last().is_some_and(|c| !c.is_whitespace())
        && inserted.chars().next().is_some_and(|c| !c.is_whitespace())
    {
        return None;
    }
    if suffix.chars().next().is_some_and(|c| !c.is_whitespace())
        && inserted.chars().last().is_some_and(|c| !c.is_whitespace())
    {
        return None;
    }
    let first = words(prefix).len();
    Some(first..first + words(pasted).len())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn app() -> ObservedApplication {
        ObservedApplication {
            name: "Fixture".into(),
            bundle_id: None,
        }
    }
    #[test]
    fn binds_selection_instead_of_guessing_repeated_text_and_handles_utf16() {
        assert_eq!(
            insertion_span(
                "😀 repeat me ",
                13..13,
                "repeat me",
                "😀 repeat me repeat me"
            ),
            Some(3..5)
        );
        assert_eq!(insertion_span("😀 ", 1..1, "name", "😀 name"), None);
        assert_eq!(insertion_span("prefix", 6..6, "word", "prefixword"), None);
        assert_eq!(
            insertion_span("draft", 0..5, "new words", "new words"),
            Some(0..2)
        );
        assert_eq!(
            insertion_span("prefix ", 7..7, "word", "changed word"),
            None
        );
    }
    #[test]
    fn multiple_dictations_keep_their_originals_and_finish_in_one_batch() {
        let mut s = EditingSession::new(String::new());
        assert!(s.insert(
            "one".into(),
            "Meet Jolo today.".into(),
            "",
            0..0,
            "Meet Jolo today.".into()
        ));
        let before = "Meet yolo today. ";
        assert!(s.insert(
            "two".into(),
            "Call Figna tomorrow.".into(),
            before,
            before.len()..before.len(),
            format!("{before}Call Figna tomorrow.")
        ));
        s.pending.latest = "Meet yolo today. Call Figma tomorrow.".into();
        let result = s.finish(app());
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].pairs[0].from, "Jolo");
        assert_eq!(result[0].pairs[0].to, "yolo");
        assert_eq!(result[1].pairs[0].to, "Figma");
    }
    #[test]
    fn undo_returns_to_original_and_produces_no_batch() {
        let mut s = EditingSession::new(String::new());
        s.insert(
            "one".into(),
            "Go to Jolo".into(),
            "",
            0..0,
            "Go to Jolo".into(),
        );
        s.pending.latest = "Go to Jolo".into();
        assert!(s.finish(app()).is_empty());
    }
    fn snapshot(value: Option<&str>, now: Instant) -> Snapshot {
        Snapshot {
            value: value.map(str::to_owned),
            focused: Some(true),
            composing: false,
            before: InputState::default(),
            after: InputState::default(),
            read_started: now,
            now,
            can_submit: true,
        }
    }
    #[test]
    fn pauses_and_enter_without_a_boundary_never_finish() {
        let mut s = EditingSession::new("Go to Jolo".into());
        let now = s.started;
        assert_eq!(
            s.observe(snapshot(Some("Go to yolo"), now)),
            Outcome::Continue
        );
        assert_eq!(
            s.observe(snapshot(Some("Go to yolo"), now + Duration::from_secs(10))),
            Outcome::Continue
        );
        let mut enter = snapshot(Some("Go to yolo\n"), now + Duration::from_secs(11));
        enter.after.submit = Some((enter.now, 0));
        assert_eq!(s.observe(enter), Outcome::Continue);
        assert_eq!(
            s.observe(snapshot(Some(""), now + Duration::from_secs(12))),
            Outcome::Discard
        );
    }
    #[test]
    fn focus_departure_validates_the_last_draft_without_replacing_it() {
        let mut s = EditingSession::new("Go to Jolo".into());
        let now = s.started;
        s.observe(snapshot(Some("Go to yolo"), now));
        let mut leaving = snapshot(Some("Go to yolo"), now);
        leaving.focused = Some(false);
        assert_eq!(s.observe(leaving), Outcome::Continue);
        let mut final_read = snapshot(Some("Go to yolo"), now + Duration::from_millis(300));
        final_read.focused = Some(false);
        assert_eq!(s.observe(final_read), Outcome::Finish);
        assert_eq!(s.pending.latest, "Go to yolo");
    }
    #[test]
    fn composition_and_unreadable_fields_invalidate_cached_submit() {
        for composing in [false, true] {
            let mut s = EditingSession::new("Go to Jolo".into());
            let now = s.started;
            s.observe(snapshot(Some("Go to yolo"), now));
            let mut uncertain = snapshot(None, now);
            uncertain.composing = composing;
            s.observe(uncertain);
            let mut cleared = snapshot(Some(""), now);
            cleared.after.submit = Some((now, 0));
            assert_eq!(s.observe(cleared), Outcome::Discard);
        }
    }
    #[test]
    fn quick_final_edit_then_submit_does_not_learn_a_stale_snapshot() {
        let mut s = EditingSession::new("Go to Jolo".into());
        let now = s.started;
        s.observe(snapshot(Some("Go to yol"), now));
        let mut cleared = snapshot(Some(""), now + Duration::from_millis(20));
        cleared.after.revision = 1;
        cleared.after.submit = Some((cleared.now, 1));
        assert_eq!(s.observe(cleared), Outcome::Discard);
    }
    #[test]
    fn fresh_snapshot_then_submit_and_clear_finishes_once() {
        let mut s = EditingSession::new("Go to Jolo".into());
        let now = s.started;
        s.observe(snapshot(Some("Go to yolo"), now));
        let mut cleared = snapshot(Some(""), now + Duration::from_millis(100));
        cleared.after.submit = Some((cleared.now, 0));
        assert_eq!(s.observe(cleared), Outcome::Finish);
        assert_eq!(s.pending.latest, "Go to yolo");
    }
    #[test]
    fn expiry_discards_and_a_replacement_dictation_does_not_teach_its_predecessor() {
        let mut s = EditingSession::new(String::new());
        s.insert(
            "one".into(),
            "Go to Jolo".into(),
            "",
            0..0,
            "Go to Jolo".into(),
        );
        s.insert(
            "two".into(),
            "Go to Figna".into(),
            "Go to Jolo",
            0..10,
            "Go to Figna".into(),
        );
        s.pending.latest = "Go to Figma".into();
        let result = s.finish(app());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].transcript_id, "two");
        let mut s = EditingSession::new("text".into());
        assert_eq!(
            s.observe(snapshot(
                Some("edited"),
                s.started + Duration::from_secs(120)
            )),
            Outcome::Discard
        );
    }
    const QUERY: &str = "Kanto is speech model built for the real world.";
    const CORRECTED_QUERY: &str = "canto is speech model built for the real world.";
    const RESULTS: &str = "google.com/search?q=canto+is+speech+model+built+for+the+real+world.&sourceid=chrome&ie=UTF-8";

    fn search_session(corrected: bool) -> EditingSession {
        let mut s = EditingSession::new(QUERY.into());
        assert!(s.insert("search".into(), QUERY.into(), "", 0..0, QUERY.into()));
        let current = if corrected { CORRECTED_QUERY } else { QUERY };
        assert_eq!(
            s.observe(snapshot(Some(current), s.started)),
            Outcome::Continue
        );
        s
    }
    fn submitted_result(s: &EditingSession, current: &str) -> Snapshot {
        let at = s.started + Duration::from_millis(200);
        let mut read = snapshot(Some(current), at + Duration::from_millis(100));
        read.after.submit = Some((at, 0));
        read
    }
    #[test]
    fn unchanged_search_navigation_does_not_create_a_history_correction() {
        let mut s = search_session(false);
        assert_eq!(s.observe(submitted_result(&s, RESULTS)), Outcome::Finish);
        assert!(
            s.finish(app()).is_empty(),
            "a navigation URL is never a correction"
        );
    }
    #[test]
    fn corrected_search_preserves_only_the_edit_before_navigation() {
        for response in [
            RESULTS,
            "Submitted successfully",
            "",
            "An unrelated next prompt",
        ] {
            let mut s = search_session(true);
            assert_eq!(s.observe(submitted_result(&s, response)), Outcome::Finish);
            let batch = s.finish(app());
            assert_eq!(batch.len(), 1);
            assert_eq!(batch[0].pairs.len(), 1);
            assert_eq!(batch[0].pairs[0].from, "Kanto");
            assert_eq!(batch[0].pairs[0].to, "canto");
        }
    }
    #[test]
    fn host_changes_without_an_edit_revision_are_discarded_even_while_focused() {
        let mut s = search_session(false);
        assert_eq!(
            s.observe(snapshot(
                Some(RESULTS),
                s.started + Duration::from_millis(200)
            )),
            Outcome::Discard
        );
        assert_eq!(s.pending.latest, QUERY);
    }
    #[test]
    fn changed_value_after_blur_cannot_replace_the_draft() {
        let mut s = search_session(true);
        let mut leaving = snapshot(Some(RESULTS), s.started + Duration::from_millis(200));
        leaving.focused = Some(false);
        assert_eq!(s.observe(leaving), Outcome::Discard);
        assert_eq!(s.pending.latest, CORRECTED_QUERY);
    }
    #[test]
    fn actual_event_time_excludes_reads_completed_after_return() {
        let now = Instant::now();
        let input = InputState::default();
        let mut pending = PendingCorrection::new(QUERY.into());
        pending.update(CORRECTED_QUERY.into(), &input, &input, now, now);
        pending.update(
            RESULTS.into(),
            &input,
            &input,
            now + Duration::from_millis(190),
            now + Duration::from_millis(210),
        );
        let submit = InputState {
            submit: Some((now + Duration::from_millis(200), 0)),
            ..input
        };
        assert_eq!(
            pending
                .before_submit(&submit, now + Duration::from_millis(300))
                .unwrap()
                .text,
            CORRECTED_QUERY
        );
        pending.invalidate();
        assert!(pending
            .before_submit(&submit, now + Duration::from_millis(300))
            .is_none());
    }
    #[test]
    fn reads_after_the_final_key_but_after_return_cannot_validate_a_stale_edit() {
        let now = Instant::now();
        let input = InputState {
            revision: 1,
            ..InputState::default()
        };
        let mut pending = PendingCorrection::new(QUERY.into());
        pending.update(
            RESULTS.into(),
            &input,
            &input,
            now,
            now + Duration::from_millis(20),
        );
        let submit = InputState {
            submit: Some((now + Duration::from_millis(10), 1)),
            ..input
        };
        assert!(pending
            .before_submit(&submit, now + Duration::from_millis(30))
            .is_none());
    }
    #[test]
    fn newline_consumes_return_so_a_later_clear_is_not_submission() {
        let mut s = search_session(true);
        let mut read = submitted_result(&s, &format!("{CORRECTED_QUERY}\n"));
        let submit = read.after.clone();
        assert_eq!(s.observe(read), Outcome::Continue);
        read = snapshot(Some(""), s.started + Duration::from_millis(400));
        read.after = submit;
        assert_eq!(s.observe(read), Outcome::Discard);
    }
    #[test]
    fn a_fast_next_key_cannot_erase_submission_and_cmd_tab_does_not_edit() {
        let now = Instant::now();
        let mut input = InputState::default();
        input.key_down(36, false, false, now);
        input.key_down(48, false, true, now);
        assert_eq!(input.revision, 0);
        assert_eq!(input.submit, Some((now, 0)));
        input.key_down(0, false, false, now);
        assert_eq!(input.revision, 1);
        assert_eq!(
            input.submit,
            Some((now, 0)),
            "Return survives the next character"
        );
        let mut s = search_session(true);
        let mut read = submitted_result(&s, RESULTS);
        input.submit = read.after.submit;
        read.after = input;
        assert_eq!(s.observe(read), Outcome::Discard);
        let mut input = InputState::default();
        input.key_down(36, true, false, now);
        assert_eq!(input.revision, 1);
        assert!(input.submit.is_none(), "Shift+Return is editing");
    }
}
