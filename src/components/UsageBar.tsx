import { t, getLocale, localizeMessage } from "../lib/i18n";
import type { UsageInfo } from "../types";

interface UsageBarProps {
  usage?: UsageInfo;
  loading?: boolean;
  compact?: boolean;
}

function formatResetTime(resetAt: number | null | undefined): string {
  if (!resetAt) return "";
  const now = Math.floor(Date.now() / 1000);
  const diff = resetAt - now;
  if (diff <= 0) return t("now");
  if (diff < 60) return t("{0}s", diff);
  if (diff < 3600) return t("{0}m", Math.floor(diff / 60));
  if (diff >= 86400) return t("{0}d {1}h", Math.floor(diff / 86400), Math.floor((diff % 86400) / 3600));
  return t("{0}h {1}m", Math.floor(diff / 3600), Math.floor((diff % 3600) / 60));
}

function formatExactResetTime(resetAt: number | null | undefined): string {
  if (!resetAt) return "";

  const date = new Date(resetAt * 1000);
  return new Intl.DateTimeFormat(getLocale(), {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}

function formatWindowDuration(minutes: number | null | undefined): string {
  if (!minutes) return "";
  if (minutes < 60) return t("{0}m", minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{0}h", hours);
  return t("{0}d", Math.floor(hours / 24));
}

export function formatCachedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(getLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function RateLimitBar({
  label,
  usedPercent,
  windowMinutes,
  resetsAt,
  compact = false,
}: {
  label: string;
  usedPercent: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
  compact?: boolean;
}) {
  // Calculate remaining percentage
  const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent));

  const tone = remainingPercent <= 10 ? "danger" : remainingPercent <= 30 ? "warning" : "normal";

  const windowLabel = formatWindowDuration(windowMinutes);
  const resetLabel = formatResetTime(resetsAt);
  const exactResetLabel = formatExactResetTime(resetsAt);

  return (
    <div className="neu-usage" data-tone={tone}>
      <div className="neu-usage-heading">
        <span>{windowLabel ? t("{0} limit", windowLabel) : label}</span>
        <strong>{remainingPercent.toFixed(0)}<small>%</small></strong>
      </div>
      <div className="neu-usage-track" role="progressbar"
        aria-label={windowLabel ? t("{0} limit", windowLabel) : label}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remainingPercent)}
        aria-valuetext={`${remainingPercent.toFixed(0)}${t("% left")}`}>
        <div className="neu-usage-fill" style={{ width: `${remainingPercent}%` }} />
      </div>
      {resetLabel && <p className="neu-usage-meta" title={exactResetLabel || undefined}>
        {t(" • resets {0}", resetLabel).replace(/^\s*•\s*/, "")}
        {!compact && exactResetLabel && ` (${exactResetLabel})`}
      </p>}
    </div>
  );
}

export function UsageBar({ usage, loading, compact = false }: UsageBarProps) {
  if (loading && !usage) {
    return (
      <div className="space-y-2">
        <div className="text-xs text-gray-400 dark:text-gray-500 italic animate-pulse">
          {t("Fetching usage...")}
        </div>
        <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden animate-pulse">
          <div className="h-full w-2/3 bg-gray-200 dark:bg-gray-700"></div>
        </div>
      </div>
    );
  }

  if (!usage) {
    return (
      <div className="text-xs text-gray-400 dark:text-gray-500 italic py-1 animate-pulse">
        {t("Fetching usage...")}
      </div>
    );
  }

  if (usage.error) {
    return (
      <div className="text-xs text-gray-400 dark:text-gray-500 italic py-1">
        {localizeMessage(usage.error)}
      </div>
    );
  }

  const hasPrimary = typeof usage.primary_used_percent === "number" && Number.isFinite(usage.primary_used_percent);
  const hasSecondary = typeof usage.secondary_used_percent === "number" && Number.isFinite(usage.secondary_used_percent);

  if (!hasPrimary && !hasSecondary) {
    return (
      <div className="text-xs text-gray-400 dark:text-gray-500 italic py-1">
        {t("No rate limit data")}
      </div>
    );
  }

  const cachedAt = formatCachedAt(usage.fetched_at);

  return (
    <div className="neu-usage-group space-y-2">
      {usage.cached && (
        <p
          className="neu-cache-note"
          role="status"
          title={t("Live quota is temporarily unavailable.")}
        >
          {cachedAt ? t("Cached quota from {0}", cachedAt) : t("Cached quota")}
        </p>
      )}
      {hasPrimary && (
        <RateLimitBar
          label={t("5h Limit")}
          usedPercent={usage.primary_used_percent!}
          windowMinutes={usage.primary_window_minutes}
          resetsAt={usage.primary_resets_at}
          compact={compact}
        />
      )}
      {hasSecondary && (
        <RateLimitBar
          label={t("Weekly Limit")}
          usedPercent={usage.secondary_used_percent!}
          windowMinutes={usage.secondary_window_minutes}
          resetsAt={usage.secondary_resets_at}
          compact={compact}
        />
      )}
      {!compact && usage.credits_balance && (
        <div className="neu-credits text-xs text-gray-500 dark:text-gray-400">
          {t("Credits:")} {usage.credits_balance}
        </div>
      )}
    </div>
  );
}
