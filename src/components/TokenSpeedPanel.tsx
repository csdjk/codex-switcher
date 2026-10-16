import { useState } from "react";
import { useTokenSpeed } from "../hooks/useTokenSpeed";
import { formatTokenSpeed, selectSpeedSession } from "../lib/tokenSpeed";
import { getLocale, t, type MessageKey } from "../lib/i18n";
import { UiIcon } from "./UiIcon";

const reasons: Record<string, MessageKey> = {
  partial_response: "Waiting for a complete response sample",
  model_unavailable: "Model metadata is not available in the recent log",
  usage_unavailable: "This response has no usable token count",
  no_output: "This response produced no output tokens",
  timing_unavailable: "This response has no usable output timing",
  short_window: "Output window is too short for a stable speed reading",
};
const states: Record<string, MessageKey> = {
  waiting: "Waiting for a new sample",
  observed: "Recent session activity",
  idle: "Last recorded response",
  stale: "Historical reading",
};

export function TokenSpeedPanel() {
  const { snapshot, error, loading } = useTokenSpeed();
  const [selectedId, setSelectedId] = useState("auto");
  const session = selectSpeedSession(snapshot, selectedId);
  const sample = session?.latest;
  const locale = getLocale();
  const missingSelection = selectedId !== "auto" && !session;
  const emptyMessage = error ? t("Could not read local speed data; retrying automatically")
    : loading ? t("Reading local session statistics...")
    : missingSelection ? t("Selected session is no longer in the recent list")
    : !session ? t("No local Codex sessions found. Run a Codex task to collect a sample.")
    : t(reasons[session.unavailable_reason ?? ""] ?? "Waiting for a complete response sample");
  const status = error ? t("Speed reader unavailable")
    : loading ? t("Reading local session statistics...")
    : session ? t(states[session.state] ?? "Last recorded response") : t("No speed sample yet");
  const recordedAt = sample && Number.isFinite(sample.completed_at)
    ? new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(sample.completed_at))
    : null;

  return <section className="neu-speed-panel" aria-labelledby="token-speed-title" data-testid="token-speed-panel">
    <div className="neu-speed-heading">
      <div className="neu-speed-title-row">
        <span className="neu-metric-icon"><UiIcon name="gauge" /></span>
        <div>
          <h3 id="token-speed-title">{t("Token output speed")}</h3>
          <p>{t("Local logs · updated after each model response")}</p>
        </div>
      </div>
      <label className="neu-speed-select">
        <span className="sr-only">{t("Speed monitoring session")}</span>
        <select value={selectedId} onChange={e => setSelectedId(e.target.value)} aria-label={t("Speed monitoring session")}>
          <option value="auto">{t("Auto · most recently active session")}</option>
          {missingSelection && <option value={selectedId}>{t("Selected session unavailable")}</option>}
          {(snapshot?.sessions ?? []).map(s => <option key={s.id} value={s.id}>{s.project} · {s.model ?? t("Unknown model")} · {s.id.slice(-8)}</option>)}
        </select>
      </label>
    </div>
    <div className="neu-speed-grid">
      <div className="neu-speed-model">
        <span className="neu-speed-label">{t("Session model")}</span>
        <strong title={session?.model ?? undefined}>{session?.model ?? "--"}</strong>
        <span className="neu-speed-status" data-state={session?.state ?? "empty"}>{status}</span>
      </div>
      <div className="neu-speed-reading">
        <span className="neu-speed-label">{t("Latest valid speed")}</span>
        <div className="neu-speed-value" data-testid="token-speed-value">{formatTokenSpeed(sample?.tokens_per_second, locale)} <small>tok/s</small></div>
        <span className="neu-speed-footnote">{sample ? t("{0} tokens · {1}s model window", sample.output_tokens.toLocaleString(locale), (sample.model_time_ms / 1000).toFixed(2)) : t("No speed sample yet")}</span>
      </div>
      <div className="neu-speed-average">
        <span className="neu-speed-label">{t("Recent average speed")}</span>
        <div className="neu-speed-value neu-speed-secondary" data-testid="token-speed-average">{formatTokenSpeed(session?.recent_average_tps, locale)} <small>tok/s</small></div>
        <span className="neu-speed-footnote">{t("Last {0} valid responses · same model", session?.sample_count ?? 0)}</span>
      </div>
    </div>
    <div className="neu-speed-bottom">
      <span className="neu-speed-footnote" data-testid="token-speed-notice">
        {sample && !error ? <>{t("Recorded at {0}", recordedAt ?? "--")}{session?.unavailable_reason ? ` · ${t("Last valid sample retained")}` : !session?.latest_in_current_turn && ` · ${t("Previous turn sample")}`}</> : emptyMessage}
      </span>
      <details className="neu-speed-details">
        <summary>{t("How speed is measured")}</summary>
        <div>
          <p>{t("Estimated from Codex output-token counts and recorded reasoning/text time windows. Includes reasoning tokens; excludes tool execution gaps. Not a per-token live benchmark.")}</p>
          <p>{t("Tool-argument generation and log timing precision can affect the estimate. Windows shorter than 0.5s and incomplete records do not produce a new sample.")}</p>
          <p>{t("Reads the 8 most recently modified local main sessions, not the foreground Codex tab or the selected account. Pin a session when running multiple tasks.")}</p>
          {sample && <p>{t("Reasoning tokens included: {0}", sample.reasoning_output_tokens.toLocaleString(locale))}</p>}
        </div>
      </details>
    </div>
    {snapshot?.partial && <p className="neu-speed-footnote">{t("Some local sessions could not be read; the list may be incomplete.")}</p>}
  </section>;
}
