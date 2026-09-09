import { useCallback, useEffect, useRef, useState } from "react";
import { invokeBackend } from "../lib/platform";
import type {
  HistoryListQuery,
  HistoryOverview,
  ProjectMutationAction,
  ProjectMutationResult,
  SessionMutationAction,
  SessionMutationSummary,
} from "../types";

export function useCodexHistory(query: HistoryListQuery) {
  const [overview, setOverview] = useState<HistoryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const refreshOnMountRef = useRef(true);

  const load = useCallback(async (forceRefresh = true) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await invokeBackend<HistoryOverview>("list_history_overview", {
        query: { ...query, forceRefresh },
      });
      if (requestId === requestIdRef.current) setOverview(result);
      return result;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (requestId === requestIdRef.current) setError(message);
      throw caught;
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const forceRefresh = refreshOnMountRef.current;
      refreshOnMountRef.current = false;
      void load(forceRefresh).catch(() => undefined);
    }, query.searchTerm ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query.searchTerm]);

  const mutateSessions = useCallback(async (actions: SessionMutationAction[]) => {
    return invokeBackend<SessionMutationSummary>("mutate_sessions", { actions });
  }, []);

  const mutateProject = useCallback(async (action: ProjectMutationAction) => {
    return invokeBackend<ProjectMutationResult>("mutate_project", { action });
  }, []);

  return {
    overview,
    loading,
    error,
    refresh: load,
    mutateSessions,
    mutateProject,
  };
}
