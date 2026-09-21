import type { AccountUsageStats } from "../types";
import { invokeBackend } from "./platform";

// The credit badge and expanded statistics consume the same response.
const pending = new Map<string, Promise<AccountUsageStats>>();
const recent = new Map<string, { value: AccountUsageStats; at: number }>();
const MAX_AGE = 5 * 60_000;

export function getAccountStats(accountId: string, force = false): Promise<AccountUsageStats> {
  const running = pending.get(accountId);
  if (running) return running;
  const now = Date.now();
  for (const [key, entry] of recent) if (now - entry.at >= MAX_AGE) recent.delete(key);
  const cached = recent.get(accountId);
  if (!force && cached) return Promise.resolve(cached.value);
  const request = invokeBackend<AccountUsageStats>("get_account_usage_stats", { accountId })
    .then(value => {
      if (value.account_id !== accountId) throw new Error("Usage statistics account mismatch");
      if (value.available && !value.error) recent.set(accountId, { value, at: Date.now() });
      else recent.delete(accountId);
      return value;
    }).finally(() => pending.delete(accountId));
  pending.set(accountId, request);
  return request;
}
