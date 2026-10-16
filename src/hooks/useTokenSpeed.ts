import { useEffect, useState } from "react";
import { invokeBackend } from "../lib/platform";
import type { TokenSpeedSnapshot } from "../lib/tokenSpeed";

/** One local read at a time. Pauses when hidden and stops completely on unmount. */
export function useTokenSpeed() {
  const [snapshot, setSnapshot] = useState<TokenSpeedSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (disposed || pending || document.hidden) return;
      clearTimeout(timer);
      pending = true;
      let failed = false;
      try {
        const data = await invokeBackend<TokenSpeedSnapshot>("get_token_speed_snapshot");
        if (!data || !Array.isArray(data.sessions)) throw new Error("Invalid speed snapshot");
        if (!disposed) { setSnapshot(data); setError(false); }
      } catch {
        failed = true;
        // Never leave a disconnected reading looking like current telemetry.
        if (!disposed) { setSnapshot(null); setError(true); }
      } finally {
        pending = false;
        if (!disposed) {
          setLoading(false);
          if (!document.hidden) timer = setTimeout(() => void poll(), failed ? 5000 : 2000);
        }
      }
    }
    const visibilityChanged = () => {
      clearTimeout(timer);
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);
  return { snapshot, error, loading };
}
