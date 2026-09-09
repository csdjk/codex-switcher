import { useCallback, useMemo, useState } from "react";
import { getLocale, localizeMessage, t } from "../lib/i18n";
import { invokeBackend } from "../lib/platform";
import { useCodexHistory } from "../hooks/useCodexHistory";
import { useDesktopReopen } from "../hooks/useDesktopReopen";
import type {
  CodexProcessInfo,
  HistoryListQuery,
  HistoryProjectFilter,
  HistoryProjectSummary,
  HistoryThreadSummary,
  ProjectMutationAction,
  SessionMutationAction,
} from "../types";

const HISTORY_PROCESS_BLOCKED_PREFIX = "Cannot manage Codex history while ";

type ConfirmDialog =
  | { kind: "delete"; threads: HistoryThreadSummary[] }
  | { kind: "archive"; threads: HistoryThreadSummary[] }
  | { kind: "rename"; thread: HistoryThreadSummary }
  | { kind: "removeProject"; project: HistoryProjectSummary }
  | null;

type PendingOperation =
  | { kind: "sessions"; actions: SessionMutationAction[]; successMessage: string }
  | { kind: "project"; action: ProjectMutationAction; successMessage: string };

interface KillCodexProcessesResult {
  targeted_count: number;
  killed_pids: number[];
  failed_pids: number[];
  reopen_token?: string | null;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString(getLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sourceLabel(source: string): string {
  switch (source) {
    case "appServer": return t("Codex app");
    case "vscode": return "VS Code";
    case "cli": return "CLI";
    case "exec": return "Exec";
    case "custom": return t("Custom");
    case "subAgent":
    case "subAgentReview":
    case "subAgentCompact":
    case "subAgentThreadSpawn":
    case "subAgentOther": return t("Sub-agent");
    default: return t("Unknown");
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "active": return t("Active");
    case "idle": return t("Idle");
    case "notLoaded": return t("Not loaded");
    case "systemError": return t("System error");
    default: return status;
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "active": return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300";
    case "idle": return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300";
    case "systemError": return "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300";
    default: return "border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300";
  }
}

function projectFilterFromValue(value: string): HistoryProjectFilter {
  if (value === "unassigned") return { kind: "unassigned" };
  if (value.startsWith("project:")) return { kind: "project", projectId: value.slice(8) };
  return { kind: "all" };
}

export function SessionManagerPage() {
  const [archived, setArchived] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [projectValue, setProjectValue] = useState("all");
  const [sourceKind, setSourceKind] = useState("");
  const [status, setStatus] = useState("");
  const [days, setDays] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [processInfo, setProcessInfo] = useState<CodexProcessInfo | null>(null);
  const [isClosingCodex, setIsClosingCodex] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);

  const updatedAfter = useMemo(() => {
    const count = Number(days);
    return count > 0 ? Math.floor(Date.now() / 1000) - count * 86400 : null;
  }, [days]);
  const query = useMemo<HistoryListQuery>(() => ({
    archived,
    cursor,
    limit: 25,
    searchTerm: searchTerm.trim() || null,
    projectFilter: projectFilterFromValue(projectValue),
    sourceKind: sourceKind || null,
    status: status || null,
    updatedAfter,
  }), [archived, cursor, projectValue, searchTerm, sourceKind, status, updatedAfter]);
  const history = useCodexHistory(query);
  const desktopReopen = useDesktopReopen(pendingOperation !== null);
  const selectedProject = history.overview?.projects.find(
    project => projectValue === `project:${project.id}`,
  );

  const resetPage = useCallback(() => {
    setCursor(null);
    setCursorHistory([]);
    setSelected(new Set());
  }, []);

  const showNotice = useCallback((message: string, error = false) => {
    setNotice({ message, error });
  }, []);

  const executeOperation = useCallback(async (operation: PendingOperation, offerProcessClose = true) => {
    setIsMutating(true);
    setNotice(null);
    try {
      let completionNotice = { message: operation.successMessage, error: false };
      if (operation.kind === "sessions") {
        const summary = await history.mutateSessions(operation.actions);
        if (summary.failed > 0) {
          const threadNames = new Map(
            (history.overview?.threads ?? []).map(thread => [thread.id, thread.title]),
          );
          const succeeded = summary.results
            .filter(result => result.success)
            .map(result => threadNames.get(result.thread_id) ?? result.thread_id)
            .slice(0, 5)
            .join("、") || "—";
          const failed = summary.results
            .filter(result => !result.success)
            .map(result => `${threadNames.get(result.thread_id) ?? result.thread_id}: ${result.error ?? t("Unknown error")}`)
            .slice(0, 5)
            .join(" · ");
          completionNotice = {
            message: t("Succeeded: {0}. Failed: {1}.", succeeded, failed),
            error: true,
          };
        }
        if (summary.warning) {
          completionNotice = {
            message: `${completionNotice.message} ${t("The change completed, but stopping the Codex app server failed: {0}", localizeMessage(summary.warning))}`,
            error: true,
          };
        }
      } else {
        const result = await history.mutateProject(operation.action);
        if (result.warning) {
          completionNotice = {
            message: `${completionNotice.message} ${t("The change completed, but stopping the Codex app server failed: {0}", localizeMessage(result.warning))}`,
            error: true,
          };
        }
        if (operation.action.action === "remove" && projectValue === `project:${operation.action.projectId}`) {
          setProjectValue("all");
        }
      }
      setSelected(new Set());
      setConfirmDialog(null);
      try {
        await history.refresh();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        showNotice(`${completionNotice.message} ${t("Refresh failed: {0}", localizeMessage(message))}`, true);
        return;
      }
      showNotice(completionNotice.message, completionNotice.error);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (offerProcessClose && message.startsWith(HISTORY_PROCESS_BLOCKED_PREFIX)) {
        try {
          const latest = await invokeBackend<CodexProcessInfo>("check_codex_processes");
          if (latest.count > 0) {
            setProcessInfo(latest);
            setPendingOperation(operation);
            setConfirmDialog(null);
            return;
          }
        } catch {
          // Preserve the authoritative mutation error below.
        }
      }
      showNotice(localizeMessage(message), true);
    } finally {
      setIsMutating(false);
    }
  }, [history, projectValue, showNotice]);

  const executeSessionActions = useCallback((
    actions: SessionMutationAction[],
    successMessage: string,
  ) => executeOperation({ kind: "sessions", actions, successMessage }), [executeOperation]);

  const closeCodexAndRetry = useCallback(async () => {
    if (!pendingOperation) return;
    setIsClosingCodex(true);
    setNotice(null);
    const shouldReopen = desktopReopen.available && desktopReopen.reopen;
    try {
      desktopReopen.rememberSelection();
      const result = await invokeBackend<KillCodexProcessesResult>("kill_codex_processes", {
        reopenDesktop: shouldReopen,
      });
      const latest = await invokeBackend<CodexProcessInfo>("check_codex_processes");
      if (latest.count > 0) {
        setProcessInfo(latest);
        showNotice(t("Could not close all Codex processes. {0} still running.", latest.count), true);
        return;
      }
      const operation = pendingOperation;
      setPendingOperation(null);
      setProcessInfo(null);
      await executeOperation(operation, false);
      if (shouldReopen && result.reopen_token) {
        try {
          await invokeBackend("reopen_closed_codex_desktop", { token: result.reopen_token });
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          showNotice(t("History updated, but reopening Codex failed: {0}", message), true);
        }
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      showNotice(t("Force close failed: {0}", message), true);
    } finally {
      setIsClosingCodex(false);
    }
  }, [desktopReopen, executeOperation, pendingOperation, showNotice]);

  const currentThreads = history.overview?.threads ?? [];
  const selectedThreads = currentThreads.filter(thread => selected.has(thread.id));
  const allPageSelected = currentThreads.length > 0 && currentThreads.every(thread => selected.has(thread.id));
  const toggleSelected = (threadId: string) => {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(threadId)) next.delete(threadId); else next.add(threadId);
      return next;
    });
  };

  const openRename = (thread: HistoryThreadSummary) => {
    setOpenMenuId(null);
    setRenameDraft(thread.title === "Untitled session" ? "" : thread.title);
    setConfirmDialog({ kind: "rename", thread });
  };

  const confirmCurrentDialog = async () => {
    if (!confirmDialog) return;
    if (confirmDialog.kind === "rename") {
      await executeSessionActions(
        [{ action: "rename", threadId: confirmDialog.thread.id, name: renameDraft }],
        t("Session renamed."),
      );
      return;
    }
    if (confirmDialog.kind === "removeProject") {
      await executeOperation({
        kind: "project",
        action: { action: "remove", projectId: confirmDialog.project.id },
        successMessage: t("Project removed. Its sessions are now unassigned."),
      });
      return;
    }
    const action = confirmDialog.kind === "delete" ? "delete" : "archive";
    await executeSessionActions(
      confirmDialog.threads.map(thread => ({ action, threadId: thread.id })),
      action === "delete" ? t("Selected sessions permanently deleted.") : t("Selected sessions archived."),
    );
  };

  return (
    <section className="space-y-3 md:space-y-4" aria-labelledby="history-heading">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="history-heading" className="text-xl font-semibold text-gray-950 dark:text-white">
            {t("Session management")}
          </h2>
          <p className="mt-1 hidden text-sm text-gray-500 dark:text-gray-400 sm:block">
            {t("Manage local Codex projects and sessions through the official app server.")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void history.refresh().catch(() => undefined)}
          disabled={history.loading || isMutating}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
          aria-label={t("Refresh sessions")}
        >
          <span className={history.loading ? "animate-spin" : ""}>↻</span>
          <span className="hidden sm:inline">{t("Refresh")}</span>
        </button>
      </div>

      {notice && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${notice.error
          ? "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
          : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300"
        }`} role="status">
          {notice.message}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        {[
          [t("Projects"), history.overview?.totals.projects ?? "—"],
          [t("Active sessions"), history.overview?.totals.active_threads ?? "—"],
          [t("Archived"), history.overview?.totals.archived_threads ?? "—"],
        ].map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-gray-800 dark:bg-gray-900 md:block md:py-3">
            <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
            <div className="text-lg font-semibold tabular-nums text-gray-950 dark:text-white md:mt-1 md:text-xl">{value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-[210px_minmax(0,1fr)] md:gap-4">
        <aside className="hidden min-w-0 rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900 md:block">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t("Projects")}</h3>
            {history.overview?.capabilities.project_management === false && (
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                {t("Read only")}
              </span>
            )}
          </div>
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => { setProjectValue("all"); resetPage(); }}
              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm ${projectValue === "all" ? "bg-gray-900 text-white dark:bg-white dark:text-gray-950" : "text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"}`}
            >
              <span>{t("All sessions")}</span>
              <span className="text-xs opacity-70">{archived ? history.overview?.totals.archived_threads : history.overview?.totals.active_threads}</span>
            </button>
            <button
              type="button"
              onClick={() => { setProjectValue("unassigned"); resetPage(); }}
              className={`flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm ${projectValue === "unassigned" ? "bg-gray-900 text-white dark:bg-white dark:text-gray-950" : "text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"}`}
            >
              {t("Unassigned")}
            </button>
            {(history.overview?.projects ?? []).map(project => (
              <div key={project.id} className={`group flex min-w-0 items-center gap-1 rounded-lg ${projectValue === `project:${project.id}` ? "bg-gray-100 dark:bg-gray-800" : "hover:bg-gray-50 dark:hover:bg-gray-800/60"}`}>
                <button
                  type="button"
                  onClick={() => { setProjectValue(`project:${project.id}`); resetPage(); }}
                  className="min-w-0 flex-1 px-2.5 py-2 text-left"
                  title={project.roots.join("\n")}
                >
                  <span className="block truncate text-sm font-medium text-gray-800 dark:text-gray-100">{project.name}</span>
                  <span className="block truncate text-[11px] text-gray-400 dark:text-gray-500">{project.roots[0] ?? t("No project root")}</span>
                </button>
                {history.overview?.capabilities.project_management && (
                  <button
                    type="button"
                    onClick={() => setConfirmDialog({ kind: "removeProject", project })}
                    className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-300"
                    aria-label={t("Remove {0} project", project.name)}
                    title={t("Remove project")}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
          {history.overview && (
            <div className="mt-3 border-t border-gray-100 pt-3 text-[11px] leading-5 text-gray-400 dark:border-gray-800 dark:text-gray-500">
              <div className="truncate" title={history.overview.capabilities.codex_home}>{history.overview.capabilities.codex_home}</div>
              <div>Codex CLI {history.overview.capabilities.cli_version}</div>
            </div>
          )}
        </aside>

        <div className="min-w-0 space-y-3">
          <div className="flex items-center gap-2 md:hidden">
            <select
              value={projectValue}
              onChange={event => { setProjectValue(event.target.value); resetPage(); }}
              aria-label={t("Projects")}
              className="h-10 min-w-0 flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            >
              <option value="all">{t("All sessions")}</option>
              <option value="unassigned">{t("Unassigned")}</option>
              {(history.overview?.projects ?? []).map(project => (
                <option key={project.id} value={`project:${project.id}`}>{project.name}</option>
              ))}
            </select>
            {selectedProject && history.overview?.capabilities.project_management && (
              <button
                type="button"
                onClick={() => setConfirmDialog({ kind: "removeProject", project: selectedProject })}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 dark:border-gray-700 dark:text-gray-300 dark:hover:border-red-800 dark:hover:bg-red-900/20 dark:hover:text-red-300"
                aria-label={t("Remove {0} project", selectedProject.name)}
                title={t("Remove project")}
              >
                ×
              </button>
            )}
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-900 md:p-3">
            <div className="flex rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
              <button
                type="button"
                onClick={() => { setArchived(false); resetPage(); }}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${!archived ? "bg-white text-gray-950 shadow-sm dark:bg-gray-950 dark:text-white" : "text-gray-500 dark:text-gray-400"}`}
              >
                {t("Current")}
              </button>
              <button
                type="button"
                onClick={() => { setArchived(true); resetPage(); }}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${archived ? "bg-white text-gray-950 shadow-sm dark:bg-gray-950 dark:text-white" : "text-gray-500 dark:text-gray-400"}`}
              >
                {t("Archived")}
              </button>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 lg:grid-cols-4">
              <label className="relative col-span-3 lg:col-span-1">
                <span className="sr-only">{t("Search sessions")}</span>
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-gray-400">⌕</span>
                <input
                  type="search"
                  value={searchTerm}
                  onChange={event => { setSearchTerm(event.target.value); resetPage(); }}
                  placeholder={t("Search title or path")}
                  className="h-9 w-full rounded-lg border border-gray-200 bg-gray-50 pl-8 pr-3 text-sm outline-none focus:border-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                />
              </label>
              <select value={sourceKind} onChange={event => { setSourceKind(event.target.value); resetPage(); }} aria-label={t("Source filter")} className="h-9 min-w-0 rounded-lg border border-gray-200 bg-gray-50 px-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white">
                <option value="">{t("All sources")}</option>
                <option value="appServer">{t("Codex app")}</option>
                <option value="vscode">VS Code</option>
                <option value="cli">CLI</option>
                <option value="exec">Exec</option>
                <option value="subAgent">{t("Sub-agent")}</option>
                <option value="custom">{t("Custom")}</option>
                <option value="unknown">{t("Unknown")}</option>
              </select>
              <select value={status} onChange={event => { setStatus(event.target.value); resetPage(); }} aria-label={t("Status filter")} className="h-9 min-w-0 rounded-lg border border-gray-200 bg-gray-50 px-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white">
                <option value="">{t("All statuses")}</option>
                <option value="active">{t("Active")}</option>
                <option value="idle">{t("Idle")}</option>
                <option value="notLoaded">{t("Not loaded")}</option>
                <option value="systemError">{t("System error")}</option>
              </select>
              <select value={days} onChange={event => { setDays(event.target.value); resetPage(); }} aria-label={t("Date filter")} className="h-9 min-w-0 rounded-lg border border-gray-200 bg-gray-50 px-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white">
                <option value="">{t("Any time")}</option>
                <option value="7">{t("Last 7 days")}</option>
                <option value="30">{t("Last 30 days")}</option>
                <option value="90">{t("Last 3 months")}</option>
              </select>
            </div>
          </div>

          {selectedThreads.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-800 dark:bg-blue-900/20">
              <span className="mr-auto text-sm font-medium text-blue-800 dark:text-blue-200">{t("{0} selected", selectedThreads.length)}</span>
              {!archived && (
                <button type="button" onClick={() => setConfirmDialog({ kind: "archive", threads: selectedThreads })} disabled={isMutating} className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800">
                  {t("Archive selected")}
                </button>
              )}
              {archived && (
                <button type="button" onClick={() => void executeSessionActions(selectedThreads.map(thread => ({ action: "unarchive", threadId: thread.id })), t("Selected sessions restored."))} disabled={isMutating} className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800">
                  {t("Restore selected")}
                </button>
              )}
              <button type="button" onClick={() => setConfirmDialog({ kind: "delete", threads: selectedThreads })} disabled={isMutating} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50">
                {t("Delete permanently")}
              </button>
            </div>
          )}

          <div className="overflow-visible rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
            {history.loading && !history.overview ? (
              <div className="flex min-h-52 items-center justify-center gap-3 text-sm text-gray-500 dark:text-gray-400"><span className="animate-spin">↻</span>{t("Loading sessions...")}</div>
            ) : history.error ? (
              <div className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
                <div className="mb-2 text-2xl">!</div>
                <h3 className="font-semibold text-gray-900 dark:text-gray-100">{t("Could not load sessions")}</h3>
                <p className="mt-1 max-w-lg break-words text-sm text-red-600 dark:text-red-300">{localizeMessage(history.error)}</p>
              </div>
            ) : currentThreads.length === 0 ? (
              <div className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
                <div className="mb-3 text-3xl">◇</div>
                <h3 className="font-semibold text-gray-900 dark:text-gray-100">{t("No sessions")}</h3>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("Try changing the project, status, source, or date filters.")}</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-2.5 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={() => setSelected(allPageSelected ? new Set() : new Set(currentThreads.map(thread => thread.id)))}
                    aria-label={t("Select this page")}
                    className="h-4 w-4 accent-gray-900 dark:accent-white"
                  />
                  <span>{t("{0} matching sessions", history.overview?.filtered_count ?? 0)}</span>
                </div>
                <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                  {currentThreads.map(thread => {
                    const project = history.overview?.projects.find(item => item.id === thread.project_id);
                    return (
                      <li key={thread.id} className="group relative flex gap-3 px-4 py-3 hover:bg-gray-50/80 dark:hover:bg-gray-800/40">
                        <input type="checkbox" checked={selected.has(thread.id)} onChange={() => toggleSelected(thread.id)} aria-label={t("Select {0}", thread.title)} className="mt-1 h-4 w-4 shrink-0 accent-gray-900 dark:accent-white" />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-950 dark:text-white" title={thread.title}>{thread.title === "Untitled session" ? t("Untitled session") : thread.title}</h3>
                            <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${statusClass(thread.status)}`}>{statusLabel(thread.status)}</span>
                          </div>
                          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
                            <span className="truncate" title={thread.cwd}>{project?.name ?? t("Unassigned")}</span>
                            <span>·</span><span>{sourceLabel(thread.source_kind)}</span>
                            <span>·</span><time dateTime={new Date(thread.recency_at * 1000).toISOString()}>{formatTimestamp(thread.recency_at)}</time>
                            {thread.descendant_count > 0 && <><span>·</span><span>{t("{0} descendants", thread.descendant_count)}</span></>}
                          </div>
                          <p className="mt-1 truncate text-[11px] text-gray-400 dark:text-gray-500" title={thread.cwd}>{thread.cwd}</p>
                          {!thread.can_mutate && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-300">{t("This active session cannot be changed yet.")}</p>}
                        </div>
                        <div className="relative shrink-0">
                          <button type="button" onClick={() => setOpenMenuId(openMenuId === thread.id ? null : thread.id)} className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200" aria-label={t("More actions for {0}", thread.title)}>•••</button>
                          {openMenuId === thread.id && (
                            <div className="absolute right-0 top-9 z-20 w-36 rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl dark:border-gray-700 dark:bg-gray-950">
                              <button type="button" onClick={() => openRename(thread)} disabled={!thread.can_mutate} className="w-full rounded-lg px-2.5 py-2 text-left text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-800">{t("Rename")}</button>
                              <button type="button" onClick={() => { setOpenMenuId(null); void executeSessionActions([{ action: archived ? "unarchive" : "archive", threadId: thread.id }], archived ? t("Session restored.") : t("Session archived.")); }} disabled={!thread.can_mutate || isMutating} className="w-full rounded-lg px-2.5 py-2 text-left text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-800">{archived ? t("Restore") : t("Archive")}</button>
                              <button type="button" onClick={() => { setOpenMenuId(null); setConfirmDialog({ kind: "delete", threads: [thread] }); }} disabled={!thread.can_mutate} className="w-full rounded-lg px-2.5 py-2 text-left text-xs text-red-600 hover:bg-red-50 disabled:opacity-40 dark:text-red-300 dark:hover:bg-red-900/20">{t("Delete permanently")}</button>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>

          {history.overview && history.overview.filtered_count > 0 && (
            <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>{t("Showing {0} sessions", currentThreads.length)}</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => { const previous = cursorHistory[cursorHistory.length - 1] ?? null; setCursorHistory(items => items.slice(0, -1)); setCursor(previous); setSelected(new Set()); }} disabled={cursorHistory.length === 0 || history.loading} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-900">{t("Previous")}</button>
                <button type="button" onClick={() => { if (!history.overview?.next_cursor) return; setCursorHistory(items => [...items, cursor]); setCursor(history.overview.next_cursor); setSelected(new Set()); }} disabled={!history.overview.next_cursor || history.loading} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-900">{t("Next")}</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {confirmDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="history-confirm-title" className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
            <div className="border-b border-gray-100 p-5 dark:border-gray-800">
              <h2 id="history-confirm-title" className="text-lg font-semibold text-gray-950 dark:text-white">
                {confirmDialog.kind === "delete" ? t("Delete sessions permanently?") : confirmDialog.kind === "archive" ? t("Archive selected sessions?") : confirmDialog.kind === "rename" ? t("Rename session") : t("Remove project?")}
              </h2>
            </div>
            <div className="space-y-3 p-5 text-sm text-gray-600 dark:text-gray-300">
              {confirmDialog.kind === "rename" && (
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-gray-500 dark:text-gray-400">{t("Session name")}</span>
                  <input autoFocus value={renameDraft} onChange={event => setRenameDraft(event.target.value)} maxLength={120} className="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm outline-none focus:border-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                </label>
              )}
              {(confirmDialog.kind === "delete" || confirmDialog.kind === "archive") && (
                <>
                  <p>{t("You selected {0} session(s).", confirmDialog.threads.length)}</p>
                  {confirmDialog.kind === "delete" && (
                    <>
                      <div className="max-h-32 overflow-y-auto rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
                        {confirmDialog.threads.map(thread => (
                          <div key={thread.id} className="py-1" title={thread.cwd}>
                            <div className="truncate font-medium text-gray-700 dark:text-gray-200">{thread.title}</div>
                            <div className="truncate text-xs text-gray-400 dark:text-gray-500">{thread.cwd}</div>
                          </div>
                        ))}
                      </div>
                      {confirmDialog.threads.some(thread => thread.descendant_count > 0) ? (
                        <p className="font-medium text-red-600 dark:text-red-300">{t("This also deletes {0} descendant session(s).", confirmDialog.threads.reduce((sum, thread) => sum + thread.descendant_count, 0))}</p>
                      ) : null}
                      <p className="font-medium text-red-600 dark:text-red-300">{t("Permanent deletion cannot be undone.")}</p>
                    </>
                  )}
                  {confirmDialog.kind === "archive" && <p>{t("Archived sessions can be restored later.")}</p>}
                </>
              )}
              {confirmDialog.kind === "removeProject" && (
                <>
                  <p>{t("Remove {0} from the Codex sidebar?", confirmDialog.project.name)}</p>
                  <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
                    {confirmDialog.project.roots.map(root => <div key={root} className="break-all text-xs text-gray-500 dark:text-gray-400">{root}</div>)}
                  </div>
                  <p>{t("The code directory will not be deleted. Existing sessions will become unassigned.")}</p>
                </>
              )}
            </div>
            <div className="flex justify-end gap-3 border-t border-gray-100 p-5 dark:border-gray-800">
              <button type="button" onClick={() => setConfirmDialog(null)} disabled={isMutating} className="rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">{t("Cancel")}</button>
              <button type="button" onClick={() => void confirmCurrentDialog()} disabled={isMutating || (confirmDialog.kind === "rename" && !renameDraft.trim())} className={`rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 ${confirmDialog.kind === "delete" || confirmDialog.kind === "removeProject" ? "bg-red-600 hover:bg-red-700" : "bg-gray-900 hover:bg-gray-800 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-200"}`}>
                {isMutating ? t("Working...") : confirmDialog.kind === "delete" ? t("Delete permanently") : confirmDialog.kind === "archive" ? t("Archive selected") : confirmDialog.kind === "rename" ? t("Save") : t("Remove project")}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingOperation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="history-process-title" className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
            <div className="border-b border-gray-100 p-5 dark:border-gray-800"><h2 id="history-process-title" className="text-lg font-semibold text-gray-950 dark:text-white">{t("Close Codex to continue?")}</h2></div>
            <div className="space-y-3 p-5">
              <p className="text-sm text-gray-600 dark:text-gray-300">{t("{0} running Codex process(es) must close before session records can change.", processInfo?.count ?? 0)}</p>
              <p className="text-sm text-red-600 dark:text-red-300">{t("Unsaved Codex work may be lost.")}</p>
              <div className="space-y-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
                {desktopReopen.checking ? <p className="text-sm text-gray-500">{t("Checking for a desktop app to reopen...")}</p> : desktopReopen.available ? (
                  <>
                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200"><input type="checkbox" checked={desktopReopen.reopen} onChange={event => desktopReopen.setReopen(event.target.checked)} disabled={isClosingCodex} className="h-4 w-4 accent-orange-600" />{t("Reopen Codex desktop after force close")}</label>
                    <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><input type="checkbox" checked={desktopReopen.remember} onChange={event => desktopReopen.setRemember(event.target.checked)} disabled={isClosingCodex} className="h-4 w-4 accent-orange-600" />{t("Remember this selection")}</label>
                  </>
                ) : <p className="text-sm text-gray-500 dark:text-gray-400">{t("No supported desktop app could be identified for reopening. Codex will only be closed.")}</p>}
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t border-gray-100 p-5 dark:border-gray-800">
              <button type="button" onClick={() => { setPendingOperation(null); setProcessInfo(null); }} disabled={isClosingCodex} className="rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200">{t("Cancel")}</button>
              <button type="button" onClick={() => void closeCodexAndRetry()} disabled={isClosingCodex || desktopReopen.checking} className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">{isClosingCodex ? t("Force closing...") : t("Close Codex and continue")}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
