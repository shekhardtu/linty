//! Dictionary terms handed to the speech engine, and the gate that decides
//! which of the engine's proposed replacements are safe to apply.
//!
//! FluidAudio's custom-vocabulary rescorer (Parakeet) over-applies: it will
//! rewrite any acoustically close span into a dictionary term. Linty's
//! dictionary knows both the right spelling and the wrong ones the engine has
//! produced before, so a candidate is applied only when the span it replaces
//! resembles one of those forms.

use serde::{Deserialize, Serialize};

/// Below this similarity a proposed replacement is discarded (0..1, 1 = identical).
pub const MIN_SIMILARITY: f64 = 0.6;

/// A dictionary term: the canonical spelling plus the misspellings the engine
/// tends to produce for it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct VocabTerm {
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
}

/// A replacement the engine proposed for a span of the raw transcript.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct VocabReplacement {
    pub from: String,
    pub to: String,
    /// Whether the engine's own rescorer would apply it.
    pub apply: bool,
    #[serde(default)]
    pub reason: String,
}

/// One replacement that made it into the text.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AppliedReplacement {
    pub from: String,
    pub to: String,
}

/// Normalised similarity in 0..1 between two words (case-insensitive,
/// punctuation stripped): 1 - levenshtein / max_len.
pub fn similarity(a: &str, b: &str) -> f64 {
    let clean = |s: &str| -> Vec<char> {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(|c| c.to_lowercase())
            .collect()
    };
    let (a, b) = (clean(a), clean(b));
    let max_len = a.len().max(b.len());
    if max_len == 0 {
        return 1.0;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        prev = cur;
    }
    1.0 - prev[b.len()] as f64 / max_len as f64
}

/// Replace `from` with `to` where `from` appears as whole words, keeping any
/// trailing punctuation that was part of `from`.
pub fn replace_whole_word(text: &str, from: &str, to: &str) -> String {
    if from.is_empty() {
        return text.to_string();
    }
    let trimmed = from.trim_end_matches(|c: char| !c.is_alphanumeric());
    let suffix = &from[trimmed.len()..];
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find(from) {
        let before_ok = rest[..pos]
            .chars()
            .last()
            .map_or(true, |c| !c.is_alphanumeric());
        let after_ok = rest[pos + from.len()..]
            .chars()
            .next()
            .map_or(true, |c| !c.is_alphanumeric());
        out.push_str(&rest[..pos]);
        if before_ok && after_ok {
            out.push_str(to);
            out.push_str(suffix);
        } else {
            out.push_str(from);
        }
        rest = &rest[pos + from.len()..];
    }
    out.push_str(rest);
    out
}

/// True when the span the engine wants to replace resembles the term or one
/// of the wrong spellings the dictionary already knows for it.
fn looks_like_term(from: &str, term: &VocabTerm) -> bool {
    std::iter::once(&term.text)
        .chain(term.aliases.iter())
        .any(|form| similarity(from, form) >= MIN_SIMILARITY)
}

/// Apply the engine's proposed replacements that pass the gate, returning the
/// new text and what changed.
pub fn apply_replacements(
    text: &str,
    replacements: &[VocabReplacement],
    terms: &[VocabTerm],
) -> (String, Vec<AppliedReplacement>) {
    let mut out = text.to_string();
    let mut applied = Vec::new();
    for candidate in replacements {
        if !candidate.apply {
            continue;
        }
        let Some(term) = terms.iter().find(|t| t.text == candidate.to) else {
            continue;
        };
        if !looks_like_term(&candidate.from, term) {
            continue;
        }
        let next = replace_whole_word(&out, &candidate.from, &candidate.to);
        if next != out {
            out = next;
            applied.push(AppliedReplacement {
                from: candidate.from.clone(),
                to: candidate.to.clone(),
            });
        }
    }
    (out, applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(text: &str, aliases: &[&str]) -> VocabTerm {
        VocabTerm {
            text: text.into(),
            aliases: aliases.iter().map(|a| a.to_string()).collect(),
        }
    }

    fn candidate(from: &str, to: &str, apply: bool) -> VocabReplacement {
        VocabReplacement {
            from: from.into(),
            to: to.into(),
            apply,
            reason: String::new(),
        }
    }

    #[test]
    fn similarity_ignores_case_and_punctuation() {
        assert_eq!(similarity("Tauri,", "tauri"), 1.0);
        assert!(similarity("Tari", "Tauri") >= MIN_SIMILARITY);
        assert!(similarity("Figna", "Figma") >= MIN_SIMILARITY);
        assert!(similarity("meeting", "Tauri") < MIN_SIMILARITY);
    }

    #[test]
    fn replaces_whole_words_and_keeps_trailing_punctuation() {
        assert_eq!(
            replace_whole_word("use Tari, not Taris", "Tari,", "Tauri"),
            "use Tauri, not Taris"
        );
        assert_eq!(
            replace_whole_word("Figna and figna", "Figna", "Figma"),
            "Figma and figna"
        );
        assert_eq!(replace_whole_word("unchanged", "", "x"), "unchanged");
    }

    #[test]
    fn applies_only_candidates_that_resemble_the_term_or_a_known_wrong_form() {
        let terms = [term("Tauri", &["Tory"]), term("Figma", &[])];
        let candidates = [
            candidate("Tory", "Tauri", true),     // known wrong form
            candidate("Figna", "Figma", true),    // close to the term
            candidate("meeting", "Tauri", true),  // rescorer over-reach
            candidate("Fima", "Figma", false),    // engine itself would not apply
            candidate("Torrey", "Zustand", true), // not a dictionary term
        ];
        let (text, applied) =
            apply_replacements("Tory and Figna at the meeting", &candidates, &terms);
        assert_eq!(text, "Tauri and Figma at the meeting");
        assert_eq!(
            applied,
            vec![
                AppliedReplacement {
                    from: "Tory".into(),
                    to: "Tauri".into()
                },
                AppliedReplacement {
                    from: "Figna".into(),
                    to: "Figma".into()
                },
            ]
        );
    }
}
