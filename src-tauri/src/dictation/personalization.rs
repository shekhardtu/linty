//! Explicit local personalization. Snippets replace whole dictations only;
//! app styles never infer identities or override a disabled cleanup setting.
use serde::Deserialize;

#[derive(Clone, Deserialize)]
pub struct VoiceSnippet {
    pub id: String,
    pub phrase: String,
    pub text: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStyleProfile {
    pub bundle_id: String,
    pub style: String,
}
fn phrase(value: &str) -> String {
    value
        .trim()
        .trim_end_matches(['.', '!', '?', '。', '！', '？'])
        .trim()
        .to_lowercase()
}
pub fn snippet<'a>(text: &str, entries: &'a [VoiceSnippet]) -> Option<&'a VoiceSnippet> {
    let key = phrase(text);
    if key.is_empty() {
        return None;
    }
    let mut matches = entries.iter().take(100).filter(|entry| {
        !entry.id.is_empty()
            && entry.phrase.chars().count() <= 120
            && !entry.text.trim().is_empty()
            && entry.text.chars().count() <= 10000
            && !entry.text.contains('\0')
            && phrase(&entry.phrase) == key
    });
    let entry = matches.next()?;
    // Ambiguous configuration must never choose an arbitrary saved reply.
    matches.next().is_none().then_some(entry)
}
pub fn style<'a>(bundle: Option<&str>, entries: &'a [AppStyleProfile]) -> Option<&'a str> {
    let bundle = bundle?;
    entries
        .iter()
        .take(100)
        .find(|entry| {
            entry.bundle_id == bundle
                && ["casual", "semi-casual", "semi-formal", "formal"]
                    .contains(&entry.style.as_str())
        })
        .map(|entry| entry.style.as_str())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn entry() -> VoiceSnippet {
        VoiceSnippet {
            id: "1".into(),
            phrase: "my signature".into(),
            text: "Thanks,\nHari\n".into(),
        }
    }
    #[test]
    fn exact_spoken_phrase_preserves_saved_text() {
        let entries = [entry()];
        assert_eq!(
            snippet(" My Signature. ", &entries).unwrap().text,
            "Thanks,\nHari\n"
        );
        for text in [
            "please add my signature",
            "my signature is long",
            "",
            "my signatures",
        ] {
            assert!(snippet(text, &entries).is_none());
        }
    }
    #[test]
    fn ambiguous_and_invalid_snippets_do_not_expand() {
        assert!(snippet("my signature", &[entry(), entry()]).is_none());
        let mut invalid = entry();
        invalid.text = "\0".into();
        assert!(snippet("my signature", &[invalid]).is_none());
    }
    #[test]
    fn style_is_exact_with_global_fallback() {
        let entries = [AppStyleProfile {
            bundle_id: "com.apple.mail".into(),
            style: "formal".into(),
        }];
        assert_eq!(style(Some("com.apple.mail"), &entries), Some("formal"));
        assert_eq!(style(Some("com.apple.mail.evil"), &entries), None);
        assert_eq!(style(None, &entries), None);
    }
}
