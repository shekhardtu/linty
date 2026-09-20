use serde::Deserialize;
use serde_json::{json, Value};
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub entry_id: String,
    pub right: String,
    pub wrong: Vec<String>,
    pub enabled: bool,
}
pub struct Applied {
    pub text: String,
    pub ids: Vec<String>,
    pub pairs: Vec<Value>,
    pub rejected: Vec<String>,
}
fn replace(text: &str, wrong: &str, right: &str) -> (String, Vec<Value>) {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let count = wrong.chars().count();
    if count == 0 {
        return (text.into(), vec![]);
    }
    let mut out = String::new();
    let mut matches = vec![];
    let mut i = 0;
    while i < chars.len() {
        let end = (i + count).min(chars.len());
        let byte_end = chars.get(end).map_or(text.len(), |c| c.0);
        let part = &text[chars[i].0..byte_end];
        if end - i == count
            && part.to_lowercase() == wrong.to_lowercase()
            && (i == 0 || !chars[i - 1].1.is_alphanumeric())
            && (end == chars.len() || !chars[end].1.is_alphanumeric())
        {
            let replacement = if part.chars().count() > 1
                && part.chars().any(char::is_alphabetic)
                && part == part.to_uppercase()
            {
                right.to_uppercase()
            } else if part.chars().next().is_some_and(char::is_uppercase)
                && right.chars().next().is_some_and(char::is_lowercase)
            {
                let mut r = right.chars();
                format!("{}{}", r.next().unwrap().to_uppercase(), r.as_str())
            } else {
                right.into()
            };
            out.push_str(&replacement);
            matches.push(json!({"from":part,"to":replacement}));
            i = end;
        } else {
            out.push(chars[i].1);
            i += 1;
        }
    }
    (out, matches)
}
pub fn apply(text: &str, entries: &[Entry]) -> Applied {
    let mut result = Applied {
        text: text.into(),
        ids: vec![],
        pairs: vec![],
        rejected: vec![],
    };
    for entry in entries.iter().filter(|e| e.enabled) {
        for wrong in &entry.wrong {
            let (candidate, pairs) = replace(&result.text, wrong, &entry.right);
            if pairs.is_empty() {
                continue;
            }
            let validation = crate::text_validation::validate(&result.text, &candidate);
            if validation
                .reasons
                .iter()
                .any(|r| *r != "named_text_changed")
            {
                result.rejected.push(entry.entry_id.clone());
                continue;
            }
            result
                .ids
                .extend(std::iter::repeat_n(entry.entry_id.clone(), pairs.len()));
            result.pairs.extend(pairs);
            result.text = candidate;
        }
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boundaries_case_and_fact_protection() {
        let e = Entry {
            entry_id: "x".into(),
            right: "Tauri".into(),
            wrong: vec!["tory".into()],
            enabled: true,
        };
        let r = apply("TORY and Tory's history", &[e]);
        assert_eq!(r.text, "TAURI and Tauri's history");
        assert_eq!(r.ids.len(), 2);
        let e = Entry {
            entry_id: "x".into(),
            right: "send".into(),
            wrong: vec!["don't send".into()],
            enabled: true,
        };
        let r = apply("don't send it", &[e]);
        assert_eq!(r.text, "don't send it");
        assert_eq!(r.rejected.len(), 1);
    }
}
