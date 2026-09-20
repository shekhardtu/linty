use super::*;

#[cfg(feature = "local-stt")]
#[test]
fn auto_detection_uses_only_the_chosen_languages() {
    let allowed = vec!["en".into(), "hi".into(), "ta".into()];
    let candidates = detection_candidates(None, &allowed).unwrap();
    let mut scores = vec![0.; whisper_rs::get_lang_max_id() as usize + 1];
    let id = |code| whisper_rs::get_lang_id(code).unwrap() as usize;
    scores[id("ur")] = 0.85;
    scores[id("hi")] = 0.10;
    scores[id("en")] = 0.02;
    assert_eq!(best_detection_language(&candidates, &scores).unwrap(), "hi");
    scores[id("en")] = 0.20;
    assert_eq!(best_detection_language(&candidates, &scores).unwrap(), "en");
    scores[id("ta")] = 0.30;
    assert_eq!(best_detection_language(&candidates, &scores).unwrap(), "ta");
    assert!(
        detection_candidates(Some("hi"), &allowed)
            .unwrap()
            .is_empty(),
        "Explicit language bypasses detection"
    );
    assert!(best_detection_language(&candidates, &[]).is_err());
    assert!(best_detection_language(&candidates, &vec![f32::NAN; scores.len()]).is_err());
}

#[cfg(feature = "local-stt")]
#[test]
fn detection_rejects_invalid_or_excess_languages() {
    for allowed in [
        vec!["xx".into()],
        vec!["auto".into()],
        vec!["hi\0".into()],
        vec!["en".into(), "hi".into(), "ta".into(), "ur".into()],
    ] {
        assert!(detection_candidates(Some("auto"), &allowed).is_err());
    }
    let allowed = vec!["hi".into()];
    assert_eq!(detection_candidates(None, &allowed).unwrap()[0].0, "hi");
}
#[test]
fn ordinary_words_and_previously_blocked_phrases_survive_every_finalizer() {
    let phrases = [
        "I",
        "a",
        "no",
        "hi",
        "OK",
        "é",
        "你",
        "да",
        "sí",
        "you",
        "thank you",
        "thanks",
        "thanks for watching",
        "thank you for watching",
        "the end",
        "bye",
        "bye bye",
        "so",
        "okay",
        "the",
        "subtitles by the amara.org community",
        "subtitles by",
        "thanks for listening",
        "please subscribe",
        "subscribe",
        "like and subscribe",
        "see you next time",
        "Thank you.",
        "THANKS!",
    ];
    for phrase in phrases {
        for engine in ["Whisper", "Parakeet", "Parakeet vocabulary"] {
            assert_eq!(finish_transcript(&format!(" {phrase} \n"), engine), phrase);
        }
    }
}

#[test]
fn repetition_is_a_diagnostic_and_never_deletes_words() {
    for text in ["yes yes yes", "No, no, no!", "go GO go", "да да да"] {
        assert!(has_repeated_word(text), "{text}");
        assert_eq!(finish_transcript(text, "test"), text);
    }
    for text in [
        "",
        "... ... ...",
        "yes yes",
        "yes yes please",
        "no, I said no",
    ] {
        assert!(!has_repeated_word(text), "{text}");
    }
}

#[test]
fn digital_silence_does_not_reach_the_decoder() {
    assert!(!audio_has_signal(&[]));
    assert!(!audio_has_signal(&vec![0.0; 16000]));
    assert!(!audio_has_signal(&vec![1e-12; 16000]));
    assert!(!audio_has_signal(&[
        f32::NAN,
        f32::INFINITY,
        f32::NEG_INFINITY
    ]));
}

#[test]
fn quiet_signal_and_short_answers_surrounded_by_pauses_are_preserved() {
    // A quiet 100 ms signal, far below the old 0.01 RMS threshold.
    let quiet: Vec<f32> = (0..1600).map(|i| (i as f32 * 0.1).sin() * 0.0001).collect();
    assert!(audio_has_signal(&quiet));
    let mut paused = vec![0.0; 16000 * 120];
    paused[16000 * 60..16000 * 60 + quiet.len()].copy_from_slice(&quiet);
    assert!(audio_has_signal(&paused));
    // A non-window-aligned ending must not be ignored.
    let mut trailing = vec![0.0; 16000];
    trailing.extend_from_slice(&quiet[..399]);
    assert!(audio_has_signal(&trailing));
}
