use neal_launch_guard::LaunchControl;
use std::{env, fs, process};

fn main() {
    let path = env::args()
        .nth(1)
        .unwrap_or_else(|| "launch-config.json".into());
    let json = fs::read_to_string(&path).unwrap_or_else(|error| {
        eprintln!("could not read {path}: {error}");
        process::exit(1);
    });
    let control: LaunchControl = serde_json::from_str(&json).unwrap_or_else(|error| {
        eprintln!("invalid launch control contract: {error}");
        process::exit(1);
    });
    let report = control.readiness_report();
    println!(
        "{}",
        serde_json::to_string_pretty(&report).expect("readiness report serializes")
    );
    if !report.ready {
        process::exit(2);
    }
}
