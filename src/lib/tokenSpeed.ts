export interface TokenSpeedSample {
  tokens_per_second: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  model_time_ms: number;
  completed_at: number;
  turn_id: string | null;
}

export interface TokenSpeedSession {
  id: string;
  project: string;
  model: string | null;
  updated_at: number;
  state: "waiting" | "observed" | "idle" | "stale";
  latest: TokenSpeedSample | null;
  latest_in_current_turn: boolean;
  recent_average_tps: number | null;
  sample_count: number;
  unavailable_reason: string | null;
}

export interface TokenSpeedSnapshot {
  sessions: TokenSpeedSession[];
  checked_at: number;
  partial: boolean;
}

export function selectSpeedSession(snapshot: TokenSpeedSnapshot | null, selectedId: string): TokenSpeedSession | null {
  const sessions = snapshot?.sessions ?? [];
  return selectedId === "auto" ? sessions[0] ?? null : sessions.find(s => s.id === selectedId) ?? null;
}

export function formatTokenSpeed(value: number | null | undefined, locale = "en-US"): string {
  if (value == null || !Number.isFinite(value) || value <= 0 || value > 100_000) return "--";
  return `≈ ${value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
}
