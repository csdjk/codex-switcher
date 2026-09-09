//! Native menu labels follow the language selected in the webview.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Listener};

static CHINESE: AtomicBool = AtomicBool::new(false);

pub fn text(english: &'static str, chinese: &'static str) -> &'static str {
    if CHINESE.load(Ordering::Relaxed) {
        chinese
    } else {
        english
    }
}

pub fn setup(app: &AppHandle) {
    let handle = app.clone();
    app.listen("language-changed", move |event| {
        let chinese = match serde_json::from_str::<String>(event.payload()).as_deref() {
            Ok("zh") => true,
            Ok("en") => false,
            _ => return,
        };
        if CHINESE.swap(chinese, Ordering::Relaxed) == chinese {
            return;
        }
        let menu_handle = handle.clone();
        if let Err(error) = handle.run_on_main_thread(move || {
            if let Err(error) = crate::app_menu::refresh(&menu_handle) {
                eprintln!("Failed to update menu language: {error}");
            }
            crate::tray::refresh(&menu_handle);
        }) {
            eprintln!("Failed to schedule menu language update: {error}");
        }
    });
}
