import { useEffect, useState } from "react";
import { t } from "../lib/i18n";
import { isTauriRuntime, openExternalUrl } from "../lib/platform";
import { checkForAppUpdate, UPDATE_REPOSITORY } from "../lib/appUpdates";
import type { AppRelease } from "../lib/appUpdates";

/** This fork checks its own Releases and never installs unsigned/upstream builds. */
export function UpdateChecker() {
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const controller = new AbortController();
    let disposed = false;
    void (async () => {
      try {
        // Compare against the actual native application, not a stale web bundle.
        const { getVersion } = await import("@tauri-apps/api/app");
        const version = await getVersion();
        if (disposed) return;
        const update = await checkForAppUpdate(version, controller.signal);
        if (!disposed) setRelease(update);
      } catch (error) {
        // Startup checks are non-blocking. Offline, timeout and rate-limit errors
        // must not be shown as 'up to date' or fall back to the original project.
        if (!disposed) console.warn("Application release check unavailable:", error);
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, []);

  const handleOpenRelease = async () => {
    if (!release || opening) return;
    setOpening(true);
    setOpenError(false);
    try {
      await openExternalUrl(release.url);
    } catch (error) {
      console.error("Could not open application release page:", error);
      setOpenError(true);
    } finally {
      setOpening(false);
    }
  };

  if (!isTauriRuntime() || !release || dismissed) return null;

  return (
    <div className="neu-update fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-lg w-full px-4"
      role="status" aria-live="polite" data-testid="app-update-notice">
      <div className="neu-surface bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl p-4">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t("Update available: v")}{release.version}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 break-words">
          {t("Update source: {0}", UPDATE_REPOSITORY)}
        </p>
        {release.body && (
          <p className="text-xs text-gray-600 dark:text-gray-300 mt-2 line-clamp-2 whitespace-pre-line break-words">
            {release.body}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
          <p className="text-xs text-gray-500 dark:text-gray-400 flex-1 min-w-32">
            {t("Download and install from this repository's release page.")}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setDismissed(true)}
              className="neu-control px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors">
              {t("Later")}
            </button>
            <button onClick={handleOpenRelease} disabled={opening}
              className="neu-control px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 text-white dark:text-gray-900 transition-colors disabled:opacity-50">
              {t("View release")}
            </button>
          </div>
        </div>
        {openError && (
          <p className="text-xs text-red-600 dark:text-red-300 mt-2" role="alert">
            {t("Could not open the release page. Please try again.")}
          </p>
        )}
      </div>
    </div>
  );
}
