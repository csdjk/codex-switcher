//! Isolated Windows visual QA: no account storage, OAuth, or network queries.
//! Run with: cargo run --example quota_icon_preview --features tauri/custom-protocol
#[cfg(target_os = "windows")]
#[path = "../src/quota_icon.rs"]
mod quota_icon;
#[cfg(target_os = "windows")]
pub use codex_switcher_lib::types;

#[cfg(target_os = "windows")]
fn main() {
    use tauri::{tray::TrayIconBuilder, Manager};
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_title("Quota Icon QA — isolated fixtures")?;
            let tray = TrayIconBuilder::with_id("quota-icon-qa")
                .icon(quota_icon::render(None)).tooltip("Quota Icon QA").build(app)?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for value in [Some(80), Some(26), Some(8), Some(0), None] {
                    let window = window.clone();
                    let tray = tray.clone();
                    handle.run_on_main_thread(move || {
                        window.set_icon(quota_icon::render(value)).unwrap();
                        tray.set_icon(Some(quota_icon::render(value))).unwrap();
                        tray.set_tooltip(Some(format!("Quota Icon QA: {value:?}"))).unwrap();
                        let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../Temp/quota-icon-qa");
                        std::fs::create_dir_all(&output).unwrap();
                        std::fs::write(output.join("preview-state.json"), serde_json::to_vec(&serde_json::json!({
                            "remaining":value,"processId":std::process::id(),"trayRect":tray.rect().unwrap()
                        })).unwrap()).unwrap();
                    }).unwrap();
                    std::thread::sleep(std::time::Duration::from_secs(8));
                }
                handle.exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("quota icon visual preview failed");
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("Quota icon visual preview requires Windows");
}
