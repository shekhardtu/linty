use super::ObservedPair;
use std::ops::Range;

pub(super) fn words(text: &str) -> Vec<String> {
    text.split_whitespace().map(String::from).collect()
}

#[derive(Debug, PartialEq)]
struct Edit {
    /// Index in the original words where the change starts (insertions: before this word).
    at: usize,
    kind: &'static str,
    from: String,
    to: String,
}

/// Changes inside the pasted span only: typing before or after the paste is not a correction.
pub(super) fn span_edits(
    before: &[String],
    after: &[String],
    span: &Range<usize>,
) -> Vec<ObservedPair> {
    word_diff(before, after)
        .into_iter()
        .filter(|e| match e.kind {
            "insertion" => e.at > span.start && e.at < span.end,
            _ => span.contains(&e.at) && e.at + words(&e.from).len() <= span.end,
        })
        .map(|e| ObservedPair {
            kind: e.kind,
            from: e.from,
            to: e.to,
        })
        .collect()
}

/// Word-level diff (longest common subsequence). Adjacent runs of deletions and
/// insertions of equal length are paired one to one, because they are almost
/// always word-for-word fixes; unequal runs become one substitution.
fn word_diff(a: &[String], b: &[String]) -> Vec<Edit> {
    let (n, m) = (a.len(), b.len());
    if n > 2000 || m > 2000 {
        return Vec::new();
    }
    let mut lcs = vec![vec![0u16; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let mut edits = Vec::new();
    let mut dels: Vec<String> = Vec::new();
    let mut ins: Vec<String> = Vec::new();
    let mut run_at = 0usize;
    let flush =
        |at: usize, dels: &mut Vec<String>, ins: &mut Vec<String>, edits: &mut Vec<Edit>| {
            if !dels.is_empty() && !ins.is_empty() {
                if dels.len() == ins.len() {
                    for (k, (from, to)) in dels.drain(..).zip(ins.drain(..)).enumerate() {
                        edits.push(Edit {
                            at: at + k,
                            kind: "substitution",
                            from,
                            to,
                        });
                    }
                } else {
                    edits.push(Edit {
                        at,
                        kind: "substitution",
                        from: dels.join(" "),
                        to: ins.join(" "),
                    });
                }
            } else if !dels.is_empty() {
                edits.push(Edit {
                    at,
                    kind: "deletion",
                    from: dels.join(" "),
                    to: String::new(),
                });
            } else if !ins.is_empty() {
                edits.push(Edit {
                    at,
                    kind: "insertion",
                    from: String::new(),
                    to: ins.join(" "),
                });
            }
            dels.clear();
            ins.clear();
        };
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            flush(run_at, &mut dels, &mut ins, &mut edits);
            i += 1;
            j += 1;
        } else {
            if dels.is_empty() && ins.is_empty() {
                run_at = i;
            }
            if lcs[i + 1][j] >= lcs[i][j + 1] {
                dels.push(a[i].clone());
                i += 1;
            } else {
                ins.push(b[j].clone());
                j += 1;
            }
        }
    }
    if i < n || j < m {
        if dels.is_empty() && ins.is_empty() {
            run_at = i;
        }
        dels.extend(a[i..].iter().cloned());
        ins.extend(b[j..].iter().cloned());
    }
    flush(run_at, &mut dels, &mut ins, &mut edits);
    edits
}

#[cfg(test)]
mod tests {
    use super::super::session::{InputState, PendingCorrection};
    use super::{span_edits, word_diff, words, Edit, ObservedPair};
    use std::time::{Duration, Instant};

    #[test]
    fn final_diff_batches_multiple_edits_and_discards_intermediate_spelling() {
        let base = words("I have to go to YOLO with Figna");
        let now = Instant::now();
        let input = InputState::default();
        let mut pending = PendingCorrection::new(base.join(" "));
        pending.update(
            "I have to go to YU with Figna".into(),
            &input,
            &input,
            now,
            now,
        );
        pending.update(
            "I have to go to YULU with Figma".into(),
            &input,
            &input,
            now + Duration::from_secs(5),
            now + Duration::from_secs(5),
        );
        assert_eq!(
            span_edits(&base, &words(&pending.latest), &(0..base.len())),
            vec![
                ObservedPair {
                    kind: "substitution",
                    from: "YOLO".into(),
                    to: "YULU".into()
                },
                ObservedPair {
                    kind: "substitution",
                    from: "Figna".into(),
                    to: "Figma".into()
                },
            ]
        );
        pending.update(base.join(" "), &input, &input, now, now);
        assert!(span_edits(&base, &words(&pending.latest), &(0..base.len())).is_empty());
    }

    #[test]
    fn a_read_racing_input_is_not_final() {
        let before = InputState::default();
        let after = InputState {
            revision: 1,
            ..before.clone()
        };
        let mut pending = PendingCorrection::new("draft".into());
        pending.update(
            "draft".into(),
            &before,
            &after,
            Instant::now(),
            Instant::now(),
        );
        assert!(!pending.fresh(&after));
    }

    fn sub(at: usize, from: &str, to: &str) -> Edit {
        Edit {
            at,
            kind: "substitution",
            from: from.into(),
            to: to.into(),
        }
    }

    #[test]
    fn pairs_adjacent_delete_and_insert_as_substitutions() {
        let edits = word_diff(
            &words("names like Tari, Zustan and Figna are spelled"),
            &words("names like Tauri, Zustand and Figma are spelled"),
        );
        assert_eq!(
            edits,
            vec![
                sub(2, "Tari,", "Tauri,"),
                sub(3, "Zustan", "Zustand"),
                sub(5, "Figna", "Figma")
            ]
        );
    }

    #[test]
    fn reports_insertions_and_deletions_with_positions() {
        assert_eq!(
            word_diff(&words("a b c"), &words("a b c d")),
            vec![Edit {
                at: 3,
                kind: "insertion",
                from: "".into(),
                to: "d".into()
            }]
        );
        assert_eq!(
            word_diff(&words("a b c"), &words("a c")),
            vec![Edit {
                at: 1,
                kind: "deletion",
                from: "b".into(),
                to: "".into()
            }]
        );
        assert!(word_diff(&words("same text"), &words("same text")).is_empty());
    }

    #[test]
    fn keeps_only_changes_inside_the_pasted_span() {
        let before = words("Hi team, ship the parakeet build today please");
        let after = words("Hello team, ship the Parakeet build today please and thanks");
        let span = 2..8; // "ship the parakeet build today please"
        assert_eq!(
            span_edits(&before, &after, &span),
            vec![ObservedPair {
                kind: "substitution",
                from: "parakeet".into(),
                to: "Parakeet".into()
            }]
        );
    }

    #[test]
    fn edits_crossing_the_span_are_not_learned() {
        assert!(span_edits(
            &words("before dictated words after"),
            &words("before replacement"),
            &(1..3)
        )
        .is_empty());
    }
}
