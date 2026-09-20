//! Uses the exact production inference path; prints text and measurements as JSON.
use linty_lib::reformat::{prepare, run, Options};
use std::path::Path;
use std::time::Instant;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args
        .get(1)
        .expect("usage: s1_bench MODEL_DIR [TRANSCRIPT] [--prepare]");
    let text = args.get(2).filter(|arg| arg.as_str() != "--prepare").map(String::as_str).unwrap_or("um please send the report on friday no sorry monday and include the budget the timeline and the risks");
    let mut engine = None;
    if args.iter().any(|arg| arg == "--prepare") {
        let started = Instant::now();
        prepare(&mut engine, Path::new(dir), || false).expect("model preparation failed");
        let preparation_ms = started.elapsed().as_secs_f64() * 1000.;
        let repeated = Instant::now();
        prepare(&mut engine, Path::new(dir), || false).expect("repeated preparation failed");
        println!(
            "{}",
            serde_json::json!({
                "preparationMs": preparation_ms,
                "repeatedPreparationMs": repeated.elapsed().as_secs_f64() * 1000.,
            })
        );
    }
    for _ in 0..2 {
        let result = run(
            &mut engine,
            Path::new(dir),
            text,
            "en",
            Options {
                styling: "semi-formal".into(),
                structure: "lists".into(),
                context: "general".into(),
            },
            || false,
        );
        println!("{}", serde_json::to_string(&result).unwrap());
    }
}
