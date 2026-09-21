import type { AccountWithUsage, UsageInfo } from "../types";

/** Both windows constrain availability; an unknown/error is never zero usage. */
export function remainingQuota(usage: UsageInfo | undefined): number | null {
  if (!usage || usage.error) return null;
  const values = [usage.primary_used_percent, usage.secondary_used_percent]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? Math.min(...values.map(value => Math.max(0, Math.min(100, 100 - value)))) : null;
}

function compareNumber(a: number | null | undefined, b: number | null | undefined, descending = false): number {
  const hasA = typeof a === "number" && Number.isFinite(a);
  const hasB = typeof b === "number" && Number.isFinite(b);
  if (!hasA || !hasB) return Number(hasB) - Number(hasA);
  return descending ? b! - a! : a! - b!;
}

export function compareAccounts(a: AccountWithUsage, b: AccountWithUsage, sort: string): number {
  const remaining = (descending: boolean) => {
    const rank = (account: AccountWithUsage) => remainingQuota(account.usage) === null ? 2 : account.usage?.cached ? 1 : 0;
    return rank(a) - rank(b) || compareNumber(remainingQuota(a.usage), remainingQuota(b.usage), descending);
  };
  const deadline = (descending = false) => compareNumber(
    a.usage?.primary_resets_at ?? a.usage?.secondary_resets_at,
    b.usage?.primary_resets_at ?? b.usage?.secondary_resets_at, descending);
  if (sort.startsWith("subscription_")) {
    const expiry = (account: AccountWithUsage) => Date.parse(account.subscription_expires_at ?? "");
    return compareNumber(expiry(a), expiry(b), sort.endsWith("desc")) || deadline() || remaining(true) || a.name.localeCompare(b.name);
  }
  if (sort.startsWith("deadline_")) {
    return deadline(sort.endsWith("desc")) || remaining(true) || a.name.localeCompare(b.name);
  }
  return remaining(sort.endsWith("desc")) || deadline() || a.name.localeCompare(b.name);
}
