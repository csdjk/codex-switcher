import { remainingQuota } from "../lib/usageModel";
import { formatCachedAt } from "./UsageBar";
import { t } from "../lib/i18n";
import type { UsageInfo } from "../types";
import { UiIcon } from "./UiIcon";

interface AccountOverviewProps {
  count: number;
  usage?: UsageInfo;
}

/** Read-only summary of already loaded data; never triggers an extra API query. */
export function AccountOverview({ count, usage }: AccountOverviewProps) {
  const quota = remainingQuota(usage);
  const remaining = quota === null ? null : Math.round(quota);
  const fetchedAt = formatCachedAt(usage?.fetched_at);
  return <div className="neu-overview">
    <div className="neu-overview-heading">
      <p className="neu-eyebrow">CODEX WORKSPACE</p>
      <h2>{t("Account overview")}</h2>
      <p className="neu-overview-caption">{t("Your accounts and usage, in one place.")}</p>
    </div>
    <div className="neu-overview-metrics">
      <div className="neu-overview-metric">
        <span className="neu-metric-icon"><UiIcon name="layers" /></span>
        <div><span>{t("Connected accounts")}</span><strong>{count}</strong></div>
      </div>
      <div className="neu-overview-metric neu-quota-metric" title={t("Lowest remaining quota window")}>
        <span className="neu-metric-icon"><UiIcon name="gauge" /></span>
        <div><span>{usage?.cached ? t("Cached quota") : t("Current remaining")}</span><strong>{remaining === null ? "--" : `${remaining}%`}</strong></div>
        {fetchedAt && <small className="neu-overview-timestamp"><span>{t("Last updated:")} </span><span>{fetchedAt}</span></small>}
      </div>
    </div>
  </div>;
}
