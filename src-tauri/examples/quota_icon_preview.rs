//! Isolated Windows visual QA: no account storage, OAuth, or network queries.
//! Run with: cargo run --example quota_icon_preview --features tauri/custom-protocol
#[cfg(target_os = "windows")]
#[path = "../src/quota_icon.rs"]
mod quota_icon;
#[cfg(target_os = "windows")]
pub use codex_switcher_lib::types;

#[cfg(target_os = "windows")]
fn main() {
    // Export the exact production renderer without opening a window, loading
    // account storage or issuing network requests. Useful for size/theme QA.
    let mut args = std::env::args_os().skip(1);
    if let Some(flag) = args.next() {
        assert_eq!(flag, "--export-dir", "expected --export-dir <directory>");
        let output = std::path::PathBuf::from(args.next().expect("missing export directory"));
        assert!(args.next().is_none(), "unexpected extra argument");
        std::fs::create_dir_all(&output).expect("create preview directory");
        let mut manifest = Vec::new();
        for value in [
            Some(0),
            Some(1),
            Some(8),
            Some(10),
            Some(11),
            Some(26),
            Some(30),
            Some(31),
            Some(50),
            Some(80),
            Some(93),
            Some(99),
            Some(100),
            None,
        ] {
            let image = quota_icon::render(value);
            let name = value
                .map(|v| v.to_string())
                .unwrap_or_else(|| "unknown".into());
            let file = format!("quota-{name}.rgba");
            std::fs::write(output.join(&file), image.rgba()).expect("write RGBA preview");
            manifest.push(serde_json::json!({
                "remaining":value,"file":file,"width":image.width(),"height":image.height()
            }));
        }
        std::fs::write(
            output.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .expect("write preview manifest");
        println!(
            "Exported {} quota fixtures to {}",
            manifest.len(),
            output.display()
        );
        return;
    }
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
