//! Conservative, delivery-only prose boundaries. Unknown apps, code, terminals,
//! selected ranges and authored snippets retain literal text.
use std::ops::Range;

pub fn adapt(
    text: &str,
    before: &str,
    selection: Range<usize>,
    bundle: Option<&str>,
    literal: bool,
) -> String {
    if literal
        || selection.start != selection.end
        || text.trim().is_empty()
        || !matches!(
            bundle,
            Some(
                "com.apple.TextEdit"
                    | "com.apple.Notes"
                    | "com.apple.mail"
                    | "com.apple.MobileSMS"
                    | "com.microsoft.Word"
                    | "com.tinyspeck.slackmacgap"
            )
        )
    {
        return text.into();
    }
    let mut units = 0;
    let mut offset = None;
    for (i, c) in before.char_indices() {
        if units == selection.start {
            offset = Some(i);
            break;
        }
        units += c.len_utf16();
    }
    if units == selection.start && offset.is_none() {
        offset = Some(before.len());
    }
    let Some(offset) = offset else {
        return text.into();
    };
    let (left, right) = before.split_at(offset);
    let previous = left.chars().next_back();
    let next = right.chars().next();
    let sentence_start = left.trim_end().is_empty()
        || left
            .rsplit_once('\n')
            .is_some_and(|(_, tail)| tail.trim().is_empty())
        || left.trim_end().ends_with(['.', '!', '?']);
    let mut output = text.to_string();
    // Restrict case edits to ASCII prose and a small set of unambiguous leading
    // function words. Preserve names, acronyms and non-Latin spelling.
    if let Some(first) = output.chars().next() {
        let leading = output.split_whitespace().next().unwrap_or("");
        if sentence_start
            && first.is_ascii_lowercase()
            && [
                "the", "this", "these", "those", "there", "please", "we", "you", "they", "it",
                "our", "your", "my", "and", "but", "or", "hello", "thanks", "thank", "i",
            ]
            .contains(&leading)
        {
            output.replace_range(..1, &first.to_ascii_uppercase().to_string());
        } else if !sentence_start {
            let first_word = output.split_whitespace().next().unwrap_or("");
            if [
                "The", "This", "These", "Those", "There", "Please", "We", "You", "They", "It",
                "Our", "Your", "My", "And", "But", "Or",
            ]
            .contains(&first_word)
            {
                output.replace_range(..1, &first.to_ascii_lowercase().to_string());
            }
        }
    }
    let first = output.chars().next();
    let last = output.chars().next_back();
    // Do not insert Western spaces around CJK or already supplied whitespace.
    if previous.is_some_and(|c| c.is_ascii_alphanumeric() || ".!?,:;".contains(c))
        && first.is_some_and(|c| c.is_ascii_alphanumeric())
    {
        output.insert(0, ' ');
    }
    if next.is_some_and(|c| c.is_ascii_alphanumeric())
        && last.is_some_and(|c| c.is_ascii_alphanumeric() || ".!?,:;".contains(c))
    {
        output.push(' ');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    const APP: Option<&str> = Some("com.apple.TextEdit");
    #[test]
    fn adapts_prose_without_touching_names_or_existing_spaces() {
        assert_eq!(
            adapt("The plan works.", "Hello", 5..5, APP, false),
            " the plan works."
        );
        assert_eq!(adapt("hello", "Done. ", 6..6, APP, false), "Hello");
        assert_eq!(adapt("iPhone", "", 0..0, APP, false), "iPhone");
        assert_eq!(adapt("eBay", "", 0..0, APP, false), "eBay");
        assert_eq!(adapt("linty", "", 0..0, APP, false), "linty");
        assert_eq!(adapt("Linty", "Use ", 4..4, APP, false), "Linty");
        assert_eq!(adapt("next", "firstlast", 5..5, APP, false), " next ");
        assert_eq!(adapt("hello", "😀 ", 3..3, APP, false), "hello");
    }
    #[test]
    fn preserves_literal_unsupported_selected_and_non_latin_text() {
        for bundle in [
            None,
            Some("com.apple.Terminal"),
            Some("com.microsoft.VSCode"),
        ] {
            assert_eq!(adapt("const x", "abc", 3..3, bundle, false), "const x");
        }
        assert_eq!(adapt("mySignature", "hi", 2..2, APP, true), "mySignature");
        assert_eq!(adapt("replace", "hello", 0..5, APP, false), "replace");
        assert_eq!(adapt("你好", "世界", 2..2, APP, false), "你好");
        assert_eq!(adapt("x", "😀", 1..1, APP, false), "x");
    }
}
