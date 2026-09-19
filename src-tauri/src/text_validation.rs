//! Shared, deterministic checks for proposed text changes. These are conservative
//! preservation checks, not a claim that arbitrary semantic equivalence is decidable.
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    pub status: &'static str,
    pub reasons: Vec<&'static str>,
}

fn words(text: &str) -> Vec<String> {
    text.replace('’', "'")
        .replace(['—', '–', '-'], " ")
        .split_whitespace()
        .map(|s| {
            s.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|s| !s.is_empty())
        .collect()
}
fn small(word: &str) -> Option<u64> {
    Some(match word {
        "zero" => 0,
        "one" => 1,
        "two" => 2,
        "three" => 3,
        "four" => 4,
        "five" => 5,
        "six" => 6,
        "seven" => 7,
        "eight" => 8,
        "nine" => 9,
        "ten" => 10,
        "eleven" => 11,
        "twelve" => 12,
        "thirteen" => 13,
        "fourteen" => 14,
        "fifteen" => 15,
        "sixteen" => 16,
        "seventeen" => 17,
        "eighteen" => 18,
        "nineteen" => 19,
        "twenty" => 20,
        "thirty" => 30,
        "forty" => 40,
        "fifty" => 50,
        "sixty" => 60,
        "seventy" => 70,
        "eighty" => 80,
        "ninety" => 90,
        _ => return None,
    })
}
fn scale(word: &str) -> Option<u64> {
    Some(match word {
        "hundred" => 100,
        "thousand" => 1_000,
        "lakh" | "lakhs" => 100_000,
        "million" => 1_000_000,
        "crore" | "crores" => 10_000_000,
        "billion" => 1_000_000_000,
        _ => return None,
    })
}
fn number_spans(tokens: &[String]) -> Vec<(std::ops::Range<usize>, String)> {
    let mut values = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let start = i;
        let digits = tokens[i].replace(',', "");
        if digits.chars().any(|c| c.is_ascii_digit()) {
            i += 1;
            values.push((
                start..i,
                digits
                    .parse::<u64>()
                    .map(|v| v.to_string())
                    .unwrap_or(digits),
            ));
        } else if small(&tokens[i]).is_some() {
            let (mut total, mut group, mut last_small) = (0u64, 0u64, None);
            while i < tokens.len() {
                if let Some(value) = small(&tokens[i]) {
                    if last_small.is_some_and(|last| last < 20 || value >= 10) {
                        break;
                    }
                    group = group.saturating_add(value);
                    last_small = Some(value);
                } else if let Some(value) = scale(&tokens[i]) {
                    last_small = None;
                    if value == 100 {
                        group = group.max(1).saturating_mul(value);
                    } else {
                        total = total.saturating_add(group.max(1).saturating_mul(value));
                        group = 0;
                    }
                } else if tokens[i] == "and"
                    && (group >= 100 || total > 0)
                    && tokens.get(i + 1).is_some_and(|w| small(w).is_some())
                {
                    last_small = None;
                } else {
                    break;
                }
                i += 1;
            }
            let mut value = total.saturating_add(group).to_string();
            if tokens.get(i).is_some_and(|w| w == "point")
                && tokens
                    .get(i + 1)
                    .and_then(|w| small(w))
                    .is_some_and(|n| n < 10)
            {
                value.push('.');
                i += 1;
                while let Some(digit) = tokens.get(i).and_then(|w| small(w)).filter(|n| *n < 10) {
                    value.push(char::from(b'0' + digit as u8));
                    i += 1;
                }
            }
            values.push((start..i, value));
        } else {
            i += 1;
        }
    }
    values
}
fn numbers(tokens: &[String]) -> Vec<String> {
    number_spans(tokens)
        .into_iter()
        .map(|(_, value)| value)
        .collect()
}

/// Resolve only adjacent, explicit replacements of two known entities. Quoted
/// and reported examples keep both alternatives. Unknown/long-distance edits
/// remain ambiguous and therefore retain the original protected details.
fn correction_reference(input: &str, tokens: &[String]) -> (Vec<String>, Vec<String>) {
    if input.contains(['`', '"'])
        || tokens.iter().any(|t| {
            ["quote", "quoted", "sentence", "example", "said", "says"].contains(&t.as_str())
        })
    {
        return (tokens.to_vec(), Vec::new());
    }
    let names: Vec<_> = input
        .split_whitespace()
        .filter(|w| w.chars().next().is_some_and(char::is_uppercase))
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .collect();
    let cue = |words: &[String]| {
        matches!(
            words.join(" ").as_str(),
            "no" | "no sorry"
                | "sorry"
                | "sorry i mean"
                | "i mean"
                | "actually"
                | "actually make that"
                | "actually make it"
                | "no make that"
                | "no get me"
        )
    };
    let mut reference = tokens.to_vec();
    let mut removed = Vec::new();
    for _ in 0..256 {
        let spans = number_spans(&reference);
        let replacement = spans
            .windows(2)
            .find_map(|pair| {
                let (left, right) = (&pair[0].0, &pair[1].0);
                let mut gap = &reference[left.end..right.start];
                if gap.first().is_some_and(|w| {
                    ["rupees", "dollars", "euros", "pounds", "percent"].contains(&w.as_str())
                }) {
                    gap = &gap[1..];
                }
                cue(gap).then_some(left.start..right.start)
            })
            .or_else(|| {
                reference.iter().enumerate().find_map(|(i, word)| {
                    if !names.contains(word) {
                        return None;
                    }
                    ((i + 2)..reference.len().min(i + 6)).find_map(|j| {
                        (names.contains(&reference[j]) && cue(&reference[i + 1..j])).then_some(i..j)
                    })
                })
            });
        let Some(range) = replacement else {
            break;
        };
        removed.extend(reference.drain(range));
    }
    let mut i = 0;
    while i < reference.len() {
        if reference[i] == "no"
            && (reference.get(i + 1).is_some_and(|w| w.ends_with("n't"))
                || reference
                    .get(i + 1..i + 3)
                    .is_some_and(|w| w == ["forget", "that"]))
        {
            removed.push(reference.remove(i));
        } else {
            i += 1;
        }
    }
    (reference, removed)
}

fn counts(tokens: &[String], terms: &[&str]) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for token in tokens.iter().filter(|t| terms.contains(&t.as_str())) {
        *out.entry(token.clone()).or_default() += 1;
    }
    out
}
fn negations(tokens: &[String]) -> usize {
    tokens
        .iter()
        .filter(|w| {
            matches!(w.as_str(), "not" | "never" | "no" | "cannot" | "without")
                || w.ends_with("n't")
        })
        .count()
}

fn negative_markers(text: &str) -> usize {
    let spoken = words(text)
        .iter()
        .filter(|w| matches!(w.as_str(), "minus" | "negative"))
        .count();
    let chars: Vec<_> = text.chars().collect();
    spoken
        + chars
            .windows(2)
            .filter(|pair| matches!(pair[0], '-' | '−') && pair[1].is_ascii_digit())
            .count()
}
fn units(text: &str) -> BTreeMap<&'static str, usize> {
    let mut found = BTreeMap::new();
    for (symbol, name) in [
        ('₹', "inr"),
        ('$', "dollar"),
        ('€', "eur"),
        ('£', "gbp"),
        ('%', "percent"),
    ] {
        let count = text.matches(symbol).count();
        if count > 0 {
            *found.entry(name).or_default() += count;
        }
    }
    for word in words(text) {
        let unit = match word.as_str() {
            "rupee" | "rupees" | "inr" => "inr",
            "dollar" | "dollars" | "usd" => "dollar",
            "euro" | "euros" | "eur" => "eur",
            "pound" | "pounds" | "gbp" => "gbp",
            "percent" | "percentage" => "percent",
            _ => continue,
        };
        *found.entry(unit).or_default() += 1;
    }
    found
}
fn changed_literals(input: &str, candidate: &str) -> bool {
    for delimiter in ['`', '"'] {
        if input
            .split(delimiter)
            .enumerate()
            .any(|(index, literal)| index % 2 == 1 && !candidate.contains(literal))
        {
            return true;
        }
    }
    input.split_whitespace().any(|token| {
        let literal = token.trim_end_matches([',', '.', ';']);
        (literal.contains("://")
            || literal.starts_with('/')
            || literal.starts_with("./")
            || literal.starts_with("~/"))
            && !candidate.contains(literal)
    })
}

pub fn validate(input: &str, candidate: &str) -> Validation {
    if input == candidate && !candidate.trim().is_empty() {
        return Validation {
            status: "unchanged",
            reasons: vec![],
        };
    }
    if candidate.trim().is_empty() && crate::reformat::is_filler_only(input) {
        return Validation {
            status: "accepted",
            reasons: vec![],
        };
    }
    let (before, removed) = correction_reference(input, &words(input));
    let after = words(candidate);
    let mut reasons = Vec::new();
    if candidate.trim().is_empty() && !crate::reformat::is_filler_only(input) {
        reasons.push("empty_output");
    }
    if ["<|", "<think>", "</think>"]
        .iter()
        .any(|s| candidate.contains(s))
    {
        reasons.push("invalid_output");
    }
    if after.len() > before.len() * 2 + 20 {
        reasons.push("excessive_expansion");
    }
    if before.len() >= 20 && after.len() * 4 < before.len() {
        reasons.push("excessive_deletion");
    }
    if numbers(&before) != numbers(&after) {
        reasons.push("numbers_changed");
    }
    if negative_markers(input) != negative_markers(candidate) {
        reasons.push("number_sign_changed");
    }
    let mut expected_units = units(input);
    for (unit, count) in units(&removed.join(" ")) {
        if let Some(value) = expected_units.get_mut(unit) {
            *value = value.saturating_sub(count);
        }
    }
    expected_units.retain(|_, count| *count > 0);
    if expected_units != units(candidate) {
        reasons.push("units_changed");
    }
    if changed_literals(input, candidate) {
        reasons.push("literal_changed");
    }
    if negations(&before) != negations(&after) {
        reasons.push("negation_changed");
    }
    let dates = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ];
    if counts(&before, &dates) != counts(&after, &dates) {
        reasons.push("dates_changed");
    }
    for word in [
        "maybe", "might", "perhaps", "probably", "possibly", "unsure",
    ] {
        if before.iter().filter(|w| *w == word).count()
            != after.iter().filter(|w| *w == word).count()
        {
            reasons.push("certainty_changed");
            break;
        }
    }
    // Protect explicit proper-name spellings already present in the transcript.
    // Lowercase names cannot reliably be identified without additional context.
    if input.split_whitespace().any(|word| {
        let word = word.trim_matches(|c: char| !c.is_alphanumeric());
        word.chars().next().is_some_and(char::is_uppercase)
            && !["um", "uh", "actually", "sorry"].contains(&word.to_lowercase().as_str())
            && word.chars().filter(|c| c.is_alphabetic()).count() > 1
            && before.contains(&word.to_lowercase())
            && !after.contains(&word.to_lowercase())
    }) {
        reasons.push("named_text_changed");
    }
    Validation {
        status: if reasons.is_empty() {
            "accepted"
        } else {
            "fallback"
        },
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_indian_amount_and_accepts_equivalent_grouping() {
        let input = "the budget is one lakh fifty thousand rupees";
        assert_eq!(
            validate(input, "The budget is ₹150,000.").status,
            "accepted"
        );
        assert_eq!(
            validate(input, "The budget is ₹1,50,000.").status,
            "accepted"
        );
        assert!(validate(input, "The budget is ₹1,050,000.")
            .reasons
            .contains(&"numbers_changed"));
    }
    #[test]
    fn rejects_changed_facts_without_rejecting_punctuation() {
        assert_eq!(
            validate(
                "um send Sara the file on Monday",
                "Send Sara the file on Monday."
            )
            .status,
            "accepted"
        );
        for (a, b, reason) in [
            ("do not send the file", "Send the file.", "negation_changed"),
            ("we might finish", "We will finish.", "certainty_changed"),
            (
                "send Sara the file",
                "Send Sarah the file.",
                "named_text_changed",
            ),
            ("meet on Monday", "Meet on Friday.", "dates_changed"),
            ("version 1.2.3", "Version 1.2.4.", "numbers_changed"),
        ] {
            assert!(validate(a, b).reasons.contains(&reason), "{reason}");
        }
        assert_eq!(
            validate("do not send it", "Don't send it.").status,
            "accepted"
        );
    }
    #[test]
    fn protects_units_signs_literals_and_separate_numbers() {
        for (input, output) in [
            ("pay fifteen rupees", "Pay $15."),
            ("minus fifteen degrees", "15 degrees"),
            ("balance -15", "Balance 15"),
            ("run `rm -rf`", "Run `rm rf`"),
            ("open https://example.test/a", "Open https://example.test/b"),
            ("one two", "3"),
            ("one and two", "3"),
        ] {
            assert_eq!(validate(input, output).status, "fallback", "{input}");
        }
        assert_eq!(validate("twenty five percent", "25%").status, "accepted");
    }
    #[test]
    fn accepts_explicit_entity_corrections_but_preserves_reported_alternatives() {
        for (input, output) in [
            (
                "pay twenty thousand no get me seven thousand rupees",
                "Pay 7,000 rupees.",
            ),
            ("meet on Thursday no sorry Tuesday", "Meet on Tuesday."),
            (
                "send it to Arjun sorry I mean Meera and copy Dev",
                "Send it to Meera and copy Dev.",
            ),
            (
                "budget five thousand actually make that six thousand rupees",
                "Budget 6,000 rupees.",
            ),
            (
                "version two point zero and one point nine",
                "Version 2.0 and 1.9.",
            ),
        ] {
            assert_eq!(validate(input, output).status, "accepted", "{input}");
        }
        for input in [
            "Thursday or Tuesday",
            "she said Thursday no Tuesday",
            "quote Thursday no Tuesday end quote",
        ] {
            assert_eq!(validate(input, "Tuesday").status, "fallback");
        }
    }
    #[test]
    fn ambiguous_corrections_fall_back_and_fillers_can_disappear() {
        assert_eq!(validate("Friday or Monday", "Monday").status, "fallback");
        assert_eq!(validate("um uh", "").status, "accepted");
        assert_eq!(validate("send it", "").status, "fallback");
    }
}
