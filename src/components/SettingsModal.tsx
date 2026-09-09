import { t, setLanguage, type Language } from "../lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopReopenPreference } from "../lib/desktopReopen";
import { invokeBackend, isTauriRuntime } from "../lib/platform";
import type { DockDisplayMode } from "../types";

type TrayDisplayMode = "icon_and_session" | "active_usage_text" | "hidden";
interface DisplaySettings {
  tray_display_mode: TrayDisplayMode;
  dock_display_mode: DockDisplayMode | null;
}

interface SettingsModalProps {
  language: Language;
  preference: DesktopReopenPreference;
  onChange: (value: DesktopReopenPreference) => void;
  onClose: () => void;
}

export function SettingsModal({ language, preference, onChange, onClose }: SettingsModalProps) {
  const [languageError, setLanguageError] = useState<string | null>(null);
  const [displaySettings, setDisplaySettings] = useState<DisplaySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const desktop = isTauriRuntime();
  const loadDisplaySettings = useCallback(async () => {
    const currentRequest = ++requestId.current;
    try {
      const settings = await invokeBackend<DisplaySettings>("get_display_settings");
      if (currentRequest === requestId.current) {
        setDisplaySettings(settings);
        setError(null);
      }
    } catch (err) {
      if (currentRequest === requestId.current) setError(String(err));
    }
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const stop = await listen("app-settings-changed", () => {
        void loadDisplaySettings();
      });
      if (disposed) stop();
      else {
        unlisten = stop;
        void loadDisplaySettings();
      }
    }).catch((err) => {
      if (!disposed) setError(String(err));
    });
    return () => {
      disposed = true;
      requestId.current += 1;
      unlisten?.();
    };
  }, [desktop, loadDisplaySettings]);

  const changeDisplaySetting = async (command: string, mode: string) => {
    setSaving(true);
    setError(null);
    try {
      await invokeBackend(command, { mode });
      // Changing tray visibility can also adjust the Dock mode, and vice versa.
      await loadDisplaySettings();
    } catch (err) {
      requestId.current += 1;
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const selectClassName = "w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 disabled:opacity-50";

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div role="dialog" aria-modal="true" aria-labelledby="settings-title" className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl w-full max-w-md mx-4 shadow-xl max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <div className="p-5 border-b border-gray-100 dark:border-gray-800">
          <h2 id="settings-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t("Settings")}</h2>
        </div>
        <div className="p-5 space-y-3 max-h-[65vh] overflow-y-auto">
          <label htmlFor="language" className="block text-sm font-medium text-gray-900 dark:text-gray-100">{t("Language")}</label>
          <select id="language" value={language} className={selectClassName} onChange={(event) => {
            setLanguageError(null);
            void setLanguage(event.target.value as Language).catch((err) => setLanguageError(String(err)));
          }}>
            <option value="zh" lang="zh-CN">简体中文</option>
            <option value="en" lang="en">English</option>
          </select>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("Language changes apply immediately and are saved on this device.")}</p>
          {languageError && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{languageError}</p>}
          <div className="border-t border-gray-100 dark:border-gray-800" />
          {desktop && (
            <>
              {displaySettings ? (
                <>
                  <label htmlFor="tray-display-mode" className="block text-sm font-medium text-gray-900 dark:text-gray-100">{t("Tray")}</label>
                  <select
                    id="tray-display-mode"
                    value={displaySettings.tray_display_mode}
                    disabled={saving}
                    onChange={(event) => void changeDisplaySetting("set_tray_display_mode", event.target.value)}
                    className={selectClassName}
                  >
                    <option value="icon_and_session">{t("Icon + Session")}</option>
                    <option value="active_usage_text">{t("Hourly + Weekly")}</option>
                    <option value="hidden">{t("Hidden")}</option>
                  </select>
                  {displaySettings.dock_display_mode !== null && (
                    <>
                      <label htmlFor="dock-display-mode" className="block text-sm font-medium text-gray-900 dark:text-gray-100">{t("Dock Icon")}</label>
                      <select
                        id="dock-display-mode"
                        value={displaySettings.dock_display_mode}
                        disabled={saving}
                        onChange={(event) => void changeDisplaySetting("set_dock_display_mode", event.target.value)}
                        className={selectClassName}
                      >
                        <option value="show_in_dock">{t("Show in Dock")}</option>
                        <option value="menu_bar_only">{t("Menu Bar Only")}</option>
                      </select>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{t("At least one of the Dock or tray icons stays visible so you can reopen Codex Switcher.")}</p>
                    </>
                  )}
                </>
              ) : !error && <p className="text-sm text-gray-500 dark:text-gray-400">{t("Loading display settings...")}</p>}
              {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{t("Could not update display settings:")} {error}</p>}
              <div className="border-t border-gray-100 dark:border-gray-800" />
            </>
          )}
          <label htmlFor="desktop-reopen-preference" className="block text-sm font-medium text-gray-900 dark:text-gray-100">
            {t("Reopen Codex after force close")}
          </label>
          <select id="desktop-reopen-preference" value={preference} onChange={(event) => onChange(event.target.value as DesktopReopenPreference)} className={selectClassName}>
            <option value="ask">{t("Ask every time")}</option>
            <option value="always">{t("Reopen desktop app")}</option>
            <option value="never">{t("Keep closed")}</option>
          </select>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("Applies to detected Codex desktop apps on macOS and Windows. When switching accounts, the app reopens after the switch succeeds. Force close always requires confirmation.")}
          </p>
        </div>
        <div className="flex justify-end p-5 border-t border-gray-100 dark:border-gray-800">
          <button onClick={onClose} disabled={saving} className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 disabled:opacity-50">{t("Done")}</button>
        </div>
      </div>
    </div>
  );
}
