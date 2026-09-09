import { t, pluralSuffix } from "../lib/i18n";
import { useCallback, useState } from "react";
import type { CodexProcessInfo } from "../types";
import { invokeBackend } from "../lib/platform";

interface KillCodexProcessesResult {
  targeted_count: number;
  killed_pids: number[];
  failed_pids: number[];
  reopen_token?: string | null;
}

interface UseForceCloseCodexProcessesOptions {
  processCount: number;
  checkProcesses: () => Promise<CodexProcessInfo | null>;
  showToast: (message: string, isError?: boolean) => void;
  formatError: (err: unknown) => string;
}

export function useForceCloseCodexProcesses({
  processCount,
  checkProcesses,
  showToast,
  formatError,
}: UseForceCloseCodexProcessesOptions) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isForceClosing, setIsForceClosing] = useState(false);

  const forceCloseCodexProcesses = useCallback(async (reopenDesktop = false) => {
    try {
      setIsForceClosing(true);

      const result = await invokeBackend<KillCodexProcessesResult>(
        "kill_codex_processes",
        { reopenDesktop }
      );
      const latestProcessInfo = await checkProcesses();
      const remainingCount = latestProcessInfo?.count ?? processCount;
      const closedCount = Math.max(0, processCount - remainingCount);

      if (!latestProcessInfo) {
        showToast(t("Could not verify that Codex closed. Account switching and reopening were skipped."), true);
      } else if (result.targeted_count === 0) {
        showToast(t("No running Codex processes found."));
      } else if (remainingCount === 0) {
        showToast(
          t("Force closed {0} Codex session{1}.", processCount, pluralSuffix(processCount))
        );
      } else if (closedCount > 0) {
        showToast(
          t("Force closed {0}/{1} Codex sessions. {2} still running.", closedCount, processCount, remainingCount),
          true
        );
      } else {
        showToast(
          t("Could not force close {0} Codex session{1}.", remainingCount, pluralSuffix(remainingCount)),
          true
        );
      }

      return { processInfo: latestProcessInfo, reopenToken: result.reopen_token ?? null };
    } catch (err) {
      console.error("Failed to force close Codex processes:", err);
      showToast(t("Force close failed: {0}", formatError(err)), true);
      return null;
    } finally {
      setConfirmOpen(false);
      setIsForceClosing(false);
    }
  }, [checkProcesses, formatError, processCount, showToast]);

  return {
    forceCloseConfirmOpen: confirmOpen,
    setForceCloseConfirmOpen: setConfirmOpen,
    isForceClosingCodex: isForceClosing,
    forceCloseCodexProcesses,
  };
}
