//! Print only the same statistics exposed to the UI. Does not call a model or read auth.
fn main() {
    match codex_switcher_lib::token_speed::read_snapshot() {
        Ok(snapshot) => println!(
            "{}",
            serde_json::to_string_pretty(&snapshot).expect("serialize metadata")
        ),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
