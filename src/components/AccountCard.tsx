import { t, getLocale } from "../lib/i18n";
import { useCallback, useState, useRef, useEffect } from "react";
import type { AccountResetCredits, AccountUsageStats as AccountUsageStatsInfo, AccountWithUsage, SubscriptionInfo } from "../types";
import { invokeBackend } from "../lib/platform";
import { AccountUsageStats } from "./AccountUsageStats";
import { ResetCreditsMenu } from "./ResetCreditsMenu";
import { UsageBar } from "./UsageBar";

const RESET_CREDITS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const USAGE_STATS_OPEN_STORAGE_KEY_PREFIX = "usage-stats-open:";

interface AccountCardProps {
  account: AccountWithUsage;
  onSwitch: () => void;
  onWarmup: () => Promise<void>;
  onDelete: () => void;
  onRefresh: () => Promise<unknown>;
  onRename: (newName: string) => Promise<void>;
  switching?: boolean;
  switchDisabled?: boolean;
  codexRunning?: boolean;
  warmingUp?: boolean;
  masked?: boolean;
  onToggleMask?: () => void;
  autoWarmupEnabled?: boolean;
  autoWarmupManagedByAll?: boolean;
  autoWarmupLabel?: string;
  onToggleAutoWarmup?: () => void;
}

function formatLastRefresh(date: Date | null): string {
  if (!date) return t("Never");
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diff < 5) return t("Just now");
  if (diff < 60) return t("{0}s ago", diff);
  if (diff < 3600) return t("{0}m ago", Math.floor(diff / 60));
  if (diff < 86400) return t("{0}h ago", Math.floor(diff / 3600));
  return date.toLocaleDateString(getLocale());
}

function getSubscriptionStatus(subscription: SubscriptionInfo | null | undefined, error?: string | null): {
  label: string;
  className: string;
} {
  const timestamp = subscription?.renews_at ?? subscription?.expires_at;
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) {
    return {
      label: error ? t("Subscription sync failed") : subscription
        ? t("Subscription date unavailable") : t("Subscription date unverified"),
      className: "text-gray-400 dark:text-gray-500",
    };
  }

  const expiryDate = new Date(timestamp);
  const formattedDate = new Intl.DateTimeFormat(getLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(expiryDate);

  const label = subscription?.renews_at ? t("Renews {0}", formattedDate) : t("Entitlement ends {0}", formattedDate);
  const stale = error || expiryDate.getTime() <= Date.now() ||
    Date.now() - Date.parse(subscription!.checked_at) > 24 * 60 * 60 * 1000;
  return {
    label: stale ? t("{0} (last checked)", label) : label,
    className: stale ? "text-amber-600 dark:text-amber-400" : "text-gray-500 dark:text-gray-400",
  };
}

function BlurredText({ children, blur }: { children: React.ReactNode; blur: boolean }) {
  return (
    <span
      className={`transition-all duration-200 select-none ${blur ? "blur-sm" : ""}`}
      style={blur ? { userSelect: "none" } : undefined}
    >
      {children}
    </span>
  );
}

export function AccountCard({
  account,
  onSwitch,
  onWarmup,
  onDelete,
  onRefresh,
  onRename,
  switching,
  switchDisabled,
  codexRunning = false,
  warmingUp,
  masked = false,
  onToggleMask,
  autoWarmupEnabled = false,
  autoWarmupManagedByAll = false,
  autoWarmupLabel,
  onToggleAutoWarmup,
}: AccountCardProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(
    account.usage && !account.usage.error ? new Date() : null
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(account.name);
  const [resetCredits, setResetCredits] = useState<AccountResetCredits | null>(null);
  const [statsOpen, setStatsOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return account.is_active;
    try {
      const stored = window.localStorage.getItem(
        `${USAGE_STATS_OPEN_STORAGE_KEY_PREFIX}${account.id}`
      );
      if (stored !== null) return stored === "1";
    } catch {
      // Fall back to default.
    }
    return account.is_active;
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const resetRequestSeq = useRef(0);

  const toggleStatsOpen = () => {
    setStatsOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(
          `${USAGE_STATS_OPEN_STORAGE_KEY_PREFIX}${account.id}`,
          next ? "1" : "0"
        );
      } catch {
        // Ignore storage errors; stats still toggle for the current session.
      }
      return next;
    });
  };

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (account.usage && !account.usage.error) {
      setLastRefresh(new Date());
    }
  }, [account.usage]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleRename = async () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== account.name) {
      try {
        await onRename(trimmed);
      } catch {
        setEditName(account.name);
      }
    } else {
      setEditName(account.name);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleRename();
    } else if (e.key === "Escape") {
      setEditName(account.name);
      setIsEditing(false);
    }
  };

  const planDisplay = account.plan_type
    ? account.plan_type.charAt(0).toUpperCase() + account.plan_type.slice(1)
    : account.auth_mode === "api_key"
      ? "API Key"
      : t("Unknown");

  const planColors: Record<string, string> = {
    pro: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-700",
    plus: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700",
    team: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700",
    enterprise: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700",
    free: "bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700",
    api_key: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700",
  };

  const planKey = account.plan_type?.toLowerCase() || "api_key";
  const planColorClass = planColors[planKey] || planColors.free;
  const showSubscriptionStatus = account.auth_mode === "chat_g_p_t";
  const subscriptionStatus = getSubscriptionStatus(account.subscription, account.subscriptionError);
  const compactResetCredits = !account.is_active;

  const loadResetCredits = useCallback(async () => {
    const requestId = ++resetRequestSeq.current;

    if (account.auth_mode !== "chat_g_p_t") {
      setResetCredits(null);
      return;
    }

    try {
      const stats = await invokeBackend<AccountUsageStatsInfo>("get_account_usage_stats", {
        accountId: account.id,
      });
      if (requestId !== resetRequestSeq.current) return;
      setResetCredits(stats.account_id === account.id ? stats.reset_credits : null);
    } catch {
      if (requestId !== resetRequestSeq.current) return;
      setResetCredits(null);
    }
  }, [account.auth_mode, account.id]);

  const handleStatsLoaded = useCallback(
    (stats: AccountUsageStatsInfo | null) => {
      setResetCredits(stats?.account_id === account.id ? stats.reset_credits : null);
    },
    [account.id]
  );

  useEffect(() => {
    setResetCredits(null);

    void loadResetCredits();
    const timer = window.setInterval(() => {
      void loadResetCredits();
    }, RESET_CREDITS_REFRESH_INTERVAL_MS);

    return () => {
      resetRequestSeq.current += 1;
      window.clearInterval(timer);
    };
  }, [loadResetCredits]);


  return (
    <div
      className={`relative rounded-xl border p-4 sm:p-5 transition-all duration-200 ${
        account.is_active
          ? "bg-white dark:bg-gray-900 border-emerald-400 shadow-sm"
          : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {account.is_active && (
              <span className="flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
            )}
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleRename}
                onKeyDown={handleKeyDown}
                className="font-semibold text-gray-900 dark:text-gray-100 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded border border-gray-300 dark:border-gray-700 focus:outline-none focus:border-gray-500 dark:focus:border-gray-500 w-full"
              />
            ) : (
              <h3
                className="font-semibold text-gray-900 dark:text-gray-100 truncate cursor-pointer hover:text-gray-600 dark:hover:text-gray-300"
                onClick={() => {
                  if (masked) return;
                  setEditName(account.name);
                  setIsEditing(true);
                }}
                title={masked ? undefined : t("Click to rename")}
              >
                <BlurredText blur={masked}>{account.name}</BlurredText>
              </h3>
            )}
          </div>
          {account.email && (
            <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
              <BlurredText blur={masked}>{account.email}</BlurredText>
            </p>
          )}
        </div>

        <div className="flex max-w-[60%] flex-wrap items-center justify-end gap-2">
          {/* Refresh */}
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors disabled:opacity-50"
            title={t("Refresh usage")}
          >
            <span className={`inline-block h-4 w-4 text-base leading-none ${isRefreshing ? "animate-spin" : ""}`}>↻</span>
          </button>
          {/* Eye toggle */}
          {onToggleMask && (
            <button
              onClick={onToggleMask}
              className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              title={masked ? t("Show info") : t("Hide info")}
            >
              {masked ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              )}
            </button>
          )}
          {/* Plan badge */}
          <span
            className={`px-2.5 py-1 text-xs font-medium rounded-full border ${planColorClass}`}
          >
            {planDisplay}
          </span>
          <ResetCreditsMenu
            compact={compactResetCredits}
            resetCredits={resetCredits}
          />
        </div>
      </div>

      {/* Usage */}
      <div className="mb-3">
        <UsageBar usage={account.usage} loading={isRefreshing || account.usageLoading} />
      </div>

      {/* Last refresh time */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-3">
        <div className="text-gray-400 dark:text-gray-500">
          {t("Last updated:")} {formatLastRefresh(lastRefresh)}
        </div>
        {showSubscriptionStatus && (
          <div className={`text-right ${subscriptionStatus.className}`} title={account.subscriptionError || (account.subscription
            ? t("Subscription checked: {0}", new Date(account.subscription.checked_at).toLocaleString(getLocale()))
            : undefined)}>
            {subscriptionStatus.label}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 mt-3">
        {account.is_active ? (
          <button
            disabled
            className="basis-full sm:basis-auto flex-1 whitespace-nowrap px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 cursor-default"
          >
            {t("✓ Active")}
          </button>
        ) : (
          <button
            onClick={onSwitch}
            disabled={switching || switchDisabled}
            className={`basis-full sm:basis-auto flex-1 whitespace-nowrap flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              codexRunning
                ? "bg-orange-100 hover:bg-orange-200 dark:bg-orange-900/30 dark:hover:bg-orange-900/50 text-orange-800 dark:text-orange-300"
                : "bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 text-white dark:text-gray-900"
            }`}
            title={codexRunning ? t("Force close running Codex processes and switch account") : undefined}
          >
            {codexRunning && !switching && (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.3 3.9 1.8 18.1A2 2 0 003.5 21h17a2 2 0 001.7-2.9L13.7 3.9a2 2 0 00-3.4 0Z" />
              </svg>
            )}
            {switching ? t("Switching...") : t("Switch")}
          </button>
        )}
        <button
          onClick={() => {
            void onWarmup();
          }}
          disabled={warmingUp}
          className={`px-3 py-2 text-sm rounded-lg transition-colors ${
            warmingUp
              ? "bg-amber-100 dark:bg-amber-900/30 text-amber-500 dark:text-amber-300"
              : "bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-700 dark:text-amber-300"
          }`}
          title={warmingUp ? t("Sending warm-up request...") : t("Send minimal warm-up request")}
        >
          ⚡
        </button>
        {onToggleAutoWarmup && (
          <button
            onClick={onToggleAutoWarmup}
            disabled={autoWarmupManagedByAll}
            className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
              autoWarmupEnabled
                ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300"
                : "bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
            } disabled:opacity-60`}
            title={
              autoWarmupManagedByAll
                ? t("Auto warm-up is enabled for all accounts")
                : autoWarmupEnabled
                  ? t("Disable auto warm-up for this account")
                : t("Enable auto warm-up for this account")
            }
          >
            <span className="flex items-center gap-1">
              <span>♻</span>
              <span>{autoWarmupLabel ?? (autoWarmupEnabled ? t("Auto: on") : t("Auto: off"))}</span>
            </span>
          </button>
        )}
        <button
          onClick={toggleStatsOpen}
          className={`px-3 py-2 text-sm rounded-lg transition-colors ${
            statsOpen
              ? "bg-indigo-50 dark:bg-indigo-900/20 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 text-indigo-600 dark:text-indigo-300"
              : "bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
          }`}
          title={statsOpen ? t("Hide usage statistics") : t("Show usage statistics")}
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M4 19V5" strokeLinecap="round" />
            <path d="M4 19h16" strokeLinecap="round" />
            <path d="M8 15l3-4 3 2 4-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={onDelete}
          className="px-3 py-2 text-sm rounded-lg bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 text-red-600 dark:text-red-300 transition-colors"
          title={t("Remove account")}
        >
          ✕
        </button>
      </div>

      <AccountUsageStats
        accountId={account.id}
        enabled={account.auth_mode === "chat_g_p_t"}
        open={statsOpen}
        usage={account.usage}
        usageLoading={account.usageLoading}
        onStatsLoaded={handleStatsLoaded}
      />
    </div>
  );
}
