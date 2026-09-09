//! Native application menu management.

use crate::language::text as tr;

use tauri::{
    menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Runtime,
};

#[cfg(target_os = "macos")]
pub(crate) use crate::types::DockDisplayMode;
use crate::{
    auth::{load_app_settings, save_app_settings},
    types::{AppSettings, TrayDisplayMode},
};

const TRAY_ICON_AND_SESSION_ID: &str = "tray-display-icon-and-session";
const TRAY_ACTIVE_USAGE_TEXT_ID: &str = "tray-display-active-usage-text";
const TRAY_HIDDEN_ID: &str = "tray-display-hidden";
const DESKTOP_REOPEN_SETTINGS_ID: &str = "desktop-reopen-settings";
#[cfg(target_os = "macos")]
pub(crate) const DOCK_SHOW_IN_DOCK_ID: &str = "dock-display-show-in-dock";
#[cfg(target_os = "macos")]
pub(crate) const DOCK_MENU_BAR_ONLY_ID: &str = "dock-display-menu-bar-only";

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    apply_saved_dock_display_mode(app);
    refresh(app)?;
    app.on_menu_event(handle_menu_event);
    Ok(())
}

pub fn refresh<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let settings = load_app_settings().unwrap_or_default();
    let menu = build_menu(app, &settings)?;
    app.set_menu(menu)?;
    if let Err(error) = app.emit("app-settings-changed", ()) {
        eprintln!("Failed to notify settings changes: {error}");
    }
    Ok(())
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let item_id = event.id();

    if item_id.as_ref() == DESKTOP_REOPEN_SETTINGS_ID {
        crate::commands::open_main_window(app.clone());
        if let Err(error) = app.emit_to("main", "desktop-reopen-settings-requested", ()) {
            eprintln!("Failed to open desktop reopen settings: {error}");
        }
        return;
    }

    if let Some(mode) = tray_display_mode_for_item(item_id.as_ref()) {
        update_tray_display_mode(app, mode);
        return;
    }

    #[cfg(target_os = "macos")]
    if let Some(mode) = dock_display_mode_for_item(item_id.as_ref()) {
        update_dock_display_mode(app, mode);
    }
}

fn tray_display_mode_for_item(item_id: &str) -> Option<TrayDisplayMode> {
    Some(match item_id {
        TRAY_ICON_AND_SESSION_ID => TrayDisplayMode::IconAndSession,
        TRAY_ACTIVE_USAGE_TEXT_ID => TrayDisplayMode::ActiveUsageText,
        TRAY_HIDDEN_ID => TrayDisplayMode::Hidden,
        _ => return None,
    })
}

pub(crate) fn update_tray_display_mode(app: &AppHandle, mode: TrayDisplayMode) {
    if let Err(error) = set_tray_display_mode(app, mode) {
        eprintln!("Failed to update tray display mode: {error}");
    }
}

pub(crate) fn set_tray_display_mode(app: &AppHandle, mode: TrayDisplayMode) -> anyhow::Result<()> {
    let mut settings = load_app_settings()?;
    settings.tray_display_mode = mode;
    #[cfg(target_os = "macos")]
    let dock_mode_changed = ensure_dock_entry_for_tray_mode(&mut settings);
    save_app_settings(&settings)?;

    #[cfg(target_os = "macos")]
    if dock_mode_changed {
        apply_dock_display_mode(app, settings.dock_display_mode);
    }
    let menu_result = refresh(app);
    crate::tray::refresh(app);
    menu_result?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn dock_display_mode_for_item(item_id: &str) -> Option<DockDisplayMode> {
    Some(match item_id {
        DOCK_SHOW_IN_DOCK_ID => DockDisplayMode::ShowInDock,
        DOCK_MENU_BAR_ONLY_ID => DockDisplayMode::MenuBarOnly,
        _ => return None,
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn update_dock_display_mode(app: &AppHandle, mode: DockDisplayMode) {
    if let Err(error) = set_dock_display_mode(app, mode) {
        eprintln!("Failed to update Dock display mode: {error}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn set_dock_display_mode<R: Runtime>(
    app: &AppHandle<R>,
    mode: DockDisplayMode,
) -> anyhow::Result<AppSettings> {
    let mut settings = load_app_settings().unwrap_or_default();
    if settings.dock_display_mode == mode {
        let changed = ensure_menu_bar_entry_for_dock_mode(&mut settings);
        if changed {
            save_app_settings(&settings)?;
        }
        apply_dock_display_mode(app, mode);
        if changed {
            if let Err(error) = refresh(app) {
                eprintln!("Failed to refresh app menu: {error}");
            }
            crate::tray::refresh(app);
        }
        return Ok(settings);
    }

    settings.dock_display_mode = mode;
    ensure_menu_bar_entry_for_dock_mode(&mut settings);
    save_app_settings(&settings)?;
    apply_dock_display_mode(app, mode);

    if let Err(error) = refresh(app) {
        eprintln!("Failed to refresh app menu: {error}");
    }
    crate::tray::refresh(app);
    Ok(settings)
}

#[cfg(target_os = "macos")]
fn apply_saved_dock_display_mode<R: Runtime>(app: &AppHandle<R>) {
    let mut settings = load_app_settings().unwrap_or_default();
    let changed = ensure_menu_bar_entry_for_dock_mode(&mut settings);
    if changed {
        if let Err(error) = save_app_settings(&settings) {
            eprintln!("Failed to save app settings: {error}");
        }
    }
    apply_dock_display_mode(app, settings.dock_display_mode);
}

#[cfg(target_os = "macos")]
fn ensure_menu_bar_entry_for_dock_mode(settings: &mut AppSettings) -> bool {
    if settings.dock_display_mode == DockDisplayMode::MenuBarOnly
        && settings.tray_display_mode == TrayDisplayMode::Hidden
    {
        settings.tray_display_mode = TrayDisplayMode::ActiveUsageText;
        true
    } else {
        false
    }
}

#[cfg(target_os = "macos")]
fn ensure_dock_entry_for_tray_mode(settings: &mut AppSettings) -> bool {
    if settings.tray_display_mode == TrayDisplayMode::Hidden
        && settings.dock_display_mode == DockDisplayMode::MenuBarOnly
    {
        settings.dock_display_mode = DockDisplayMode::ShowInDock;
        true
    } else {
        false
    }
}

#[cfg(target_os = "macos")]
fn apply_dock_display_mode<R: Runtime>(app: &AppHandle<R>, mode: DockDisplayMode) {
    let visible = mode == DockDisplayMode::ShowInDock;
    if let Err(error) = app.set_dock_visibility(visible) {
        eprintln!("Failed to update Dock visibility: {error}");
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, settings: &AppSettings) -> tauri::Result<Menu<R>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let tray_settings = Submenu::with_items(
        app,
        tr("Tray", "托盘"),
        true,
        &[
            &CheckMenuItem::with_id(
                app,
                TRAY_ICON_AND_SESSION_ID,
                tr("Icon + Session", "图标 + 会话额度"),
                true,
                settings.tray_display_mode == TrayDisplayMode::IconAndSession,
                None::<&str>,
            )?,
            &CheckMenuItem::with_id(
                app,
                TRAY_ACTIVE_USAGE_TEXT_ID,
                tr("Hourly + Weekly", "小时额度 + 每周额度"),
                true,
                settings.tray_display_mode == TrayDisplayMode::ActiveUsageText,
                None::<&str>,
            )?,
            &CheckMenuItem::with_id(
                app,
                TRAY_HIDDEN_ID,
                tr("Hidden", "隐藏"),
                true,
                settings.tray_display_mode == TrayDisplayMode::Hidden,
                None::<&str>,
            )?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let dock_settings = Submenu::with_items(
        app,
        tr("Dock Icon", "程序坞图标"),
        true,
        &[
            &CheckMenuItem::with_id(
                app,
                DOCK_SHOW_IN_DOCK_ID,
                tr("Show in Dock", "显示在程序坞"),
                true,
                settings.dock_display_mode == DockDisplayMode::ShowInDock,
                None::<&str>,
            )?,
            &CheckMenuItem::with_id(
                app,
                DOCK_MENU_BAR_ONLY_ID,
                tr("Menu Bar Only", "仅菜单栏"),
                true,
                settings.dock_display_mode == DockDisplayMode::MenuBarOnly,
                None::<&str>,
            )?,
        ],
    )?;

    let desktop_reopen_settings = MenuItem::with_id(
        app,
        DESKTOP_REOPEN_SETTINGS_ID,
        tr(
            "Reopen Codex after force close...",
            "强制关闭后重新打开 Codex…",
        ),
        cfg!(any(target_os = "macos", windows)),
        None::<&str>,
    )?;

    #[cfg(target_os = "macos")]
    let settings_menu = Submenu::with_items(
        app,
        tr("Settings", "设置"),
        true,
        &[&tray_settings, &dock_settings, &desktop_reopen_settings],
    )?;

    #[cfg(not(target_os = "macos"))]
    let settings_menu = Submenu::with_items(
        app,
        tr("Settings", "设置"),
        true,
        &[&tray_settings, &desktop_reopen_settings],
    )?;

    let window_menu = Submenu::with_items(
        app,
        tr("Window", "窗口"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(tr("Minimize", "最小化")))?,
            &PredefinedMenuItem::maximize(app, Some(tr("Maximize", "最大化")))?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some(tr("Close Window", "关闭窗口")))?,
        ],
    )?;

    let help_menu = Submenu::with_items(app, tr("Help", "帮助"), true, &[])?;

    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(
                        app,
                        Some(tr("About Codex Switcher", "关于 Codex Switcher")),
                        Some(about_metadata),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &settings_menu,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, Some(tr("Services", "服务")))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(
                        app,
                        Some(tr("Hide Codex Switcher", "隐藏 Codex Switcher")),
                    )?,
                    &PredefinedMenuItem::hide_others(app, Some(tr("Hide Others", "隐藏其他应用")))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, Some(tr("Quit", "退出")))?,
                ],
            )?,
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            &Submenu::with_items(
                app,
                tr("File", "文件"),
                true,
                &[
                    &PredefinedMenuItem::close_window(app, Some(tr("Close Window", "关闭窗口")))?,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::quit(app, Some(tr("Quit", "退出")))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                tr("Edit", "编辑"),
                true,
                &[
                    &PredefinedMenuItem::undo(app, Some(tr("Undo", "撤销")))?,
                    &PredefinedMenuItem::redo(app, Some(tr("Redo", "重做")))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, Some(tr("Cut", "剪切")))?,
                    &PredefinedMenuItem::copy(app, Some(tr("Copy", "复制")))?,
                    &PredefinedMenuItem::paste(app, Some(tr("Paste", "粘贴")))?,
                    &PredefinedMenuItem::select_all(app, Some(tr("Select All", "全选")))?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                tr("View", "视图"),
                true,
                &[&PredefinedMenuItem::fullscreen(
                    app,
                    Some(tr("Toggle Full Screen", "切换全屏")),
                )?],
            )?,
            #[cfg(not(target_os = "macos"))]
            &settings_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{ensure_dock_entry_for_tray_mode, ensure_menu_bar_entry_for_dock_mode};
    use crate::types::{AppSettings, DockDisplayMode, TrayDisplayMode};

    #[test]
    fn menu_bar_only_dock_mode_keeps_a_visible_tray_entry() {
        let mut settings = AppSettings {
            tray_display_mode: TrayDisplayMode::Hidden,
            dock_display_mode: DockDisplayMode::MenuBarOnly,
            ..Default::default()
        };

        assert!(ensure_menu_bar_entry_for_dock_mode(&mut settings));
        assert_eq!(settings.tray_display_mode, TrayDisplayMode::ActiveUsageText);
        assert_eq!(settings.dock_display_mode, DockDisplayMode::MenuBarOnly);
    }

    #[test]
    fn hidden_tray_mode_keeps_a_visible_dock_entry() {
        let mut settings = AppSettings {
            tray_display_mode: TrayDisplayMode::Hidden,
            dock_display_mode: DockDisplayMode::MenuBarOnly,
            ..Default::default()
        };

        assert!(ensure_dock_entry_for_tray_mode(&mut settings));
        assert_eq!(settings.tray_display_mode, TrayDisplayMode::Hidden);
        assert_eq!(settings.dock_display_mode, DockDisplayMode::ShowInDock);
    }
}
