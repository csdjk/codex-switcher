//! Last-successful quota cache.
//!
//! This cache deliberately contains only usage metadata, never OAuth tokens.
//! It lets Codex Switcher keep showing a clearly marked recent quota snapshot
//! when the live ChatGPT request is temporarily unavailable.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

use crate::{auth::get_config_dir, types::UsageInfo};

const CACHE_VERSION: u32 = 1;
const MAX_CACHE_AGE_SECONDS: i64 = 8 * 24 * 60 * 60;
const MAX_UNKNOWN_RESET_AGE_SECONDS: i64 = 30 * 60;

#[derive(Debug, Serialize, Deserialize)]
struct UsageCacheRecord {
    version: u32,
    usage: UsageInfo,
}

fn cache_file(account_id: &str) -> Result<PathBuf> {
    let digest = Sha256::digest(account_id.as_bytes());
    let file_name = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(get_config_dir()?
        .join("usage-cache")
        .join(format!("{file_name}.json")))
}

pub fn store_successful_usage(usage: &UsageInfo) -> Result<()> {
    if usage.error.is_some() || usage.cached {
        return Ok(());
    }
    let path = cache_file(&usage.account_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "Failed to create usage cache directory: {}",
                parent.display()
            )
        })?;
    }
    let payload = serde_json::to_vec(&UsageCacheRecord {
        version: CACHE_VERSION,
        usage: usage.clone(),
    })
    .context("Failed to serialize usage cache")?;
    fs::write(&path, payload)
        .with_context(|| format!("Failed to write usage cache: {}", path.display()))
}

pub fn load_cached_usage(account_id: &str, now: DateTime<Utc>) -> Result<Option<UsageInfo>> {
    let path = cache_file(account_id)?;
    if !path.exists() {
        return Ok(None);
    }
    let payload = fs::read(&path)
        .with_context(|| format!("Failed to read usage cache: {}", path.display()))?;
    let record: UsageCacheRecord =
        serde_json::from_slice(&payload).context("Failed to parse usage cache")?;
    if record.version != CACHE_VERSION || record.usage.account_id != account_id {
        return Ok(None);
    }
    Ok(validate_cached_usage(record.usage, now))
}

fn validate_cached_usage(mut usage: UsageInfo, now: DateTime<Utc>) -> Option<UsageInfo> {
    if usage.error.is_some() {
        return None;
    }
    let fetched_at = usage.fetched_at?;
    let age = now.signed_duration_since(fetched_at).num_seconds();
    if !(-300..=MAX_CACHE_AGE_SECONDS).contains(&age) {
        return None;
    }

    let now_ts = now.timestamp();
    let keep_primary = valid_window(
        usage.primary_used_percent,
        usage.primary_resets_at,
        age,
        now_ts,
    );
    if !keep_primary {
        usage.primary_used_percent = None;
        usage.primary_window_minutes = None;
        usage.primary_resets_at = None;
    }
    let keep_secondary = valid_window(
        usage.secondary_used_percent,
        usage.secondary_resets_at,
        age,
        now_ts,
    );
    if !keep_secondary {
        usage.secondary_used_percent = None;
        usage.secondary_window_minutes = None;
        usage.secondary_resets_at = None;
    }

    if !keep_primary && !keep_secondary {
        return None;
    }
    usage.cached = true;
    usage.error = None;
    Some(usage)
}

fn valid_window(
    used_percent: Option<f64>,
    resets_at: Option<i64>,
    age_seconds: i64,
    now_ts: i64,
) -> bool {
    let Some(used_percent) = used_percent else {
        return false;
    };
    if !used_percent.is_finite() {
        return false;
    }
    match resets_at {
        Some(reset) => reset > now_ts,
        None => age_seconds <= MAX_UNKNOWN_RESET_AGE_SECONDS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(now: DateTime<Utc>) -> UsageInfo {
        UsageInfo {
            account_id: "account".into(),
            plan_type: Some("pro".into()),
            primary_used_percent: Some(25.0),
            primary_window_minutes: Some(300),
            primary_resets_at: Some(now.timestamp() + 3600),
            secondary_used_percent: Some(60.0),
            secondary_window_minutes: Some(10080),
            secondary_resets_at: Some(now.timestamp() + 3 * 86400),
            has_credits: None,
            unlimited_credits: None,
            credits_balance: None,
            cached: false,
            fetched_at: Some(now - chrono::Duration::minutes(5)),
            error: None,
        }
    }

    #[test]
    fn cached_usage_keeps_only_windows_that_have_not_reset() {
        let now = Utc::now();
        let mut value = usage(now);
        value.primary_resets_at = Some(now.timestamp() - 1);
        let cached = validate_cached_usage(value, now).unwrap();
        assert!(cached.cached);
        assert!(cached.primary_used_percent.is_none());
        assert_eq!(cached.secondary_used_percent, Some(60.0));
    }

    #[test]
    fn expired_cache_is_not_presented_as_current_quota() {
        let now = Utc::now();
        let mut value = usage(now);
        value.fetched_at = Some(now - chrono::Duration::days(9));
        assert!(validate_cached_usage(value, now).is_none());
    }

    #[test]
    fn unknown_reset_window_is_only_reused_briefly() {
        let now = Utc::now();
        let mut value = usage(now);
        value.secondary_used_percent = None;
        value.secondary_resets_at = None;
        value.primary_resets_at = None;
        value.fetched_at = Some(now - chrono::Duration::minutes(31));
        assert!(validate_cached_usage(value, now).is_none());
    }
}
