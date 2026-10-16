//! Read-only, bounded Codex rollout telemetry. No auth/config access or network requests.
//! TPS is an estimate from official output counters / recorded model-item windows,
//! not a raw streaming or server-side decoding benchmark. See docs/Token输出速度.md.
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TAIL_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TAIL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_SESSIONS: usize = 8;
const RECENT_SAMPLES: usize = 5;
const MIN_WINDOW_MS: i64 = 500;
const STALE_AFTER_MS: i64 = 120_000;

#[derive(Debug, Clone, Serialize)]
pub struct SpeedSample {
    pub tokens_per_second: f64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub model_time_ms: u64,
    pub completed_at: i64,
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpeedSession {
    pub id: String,
    pub project: String,
    pub model: Option<String>,
    pub updated_at: i64,
    pub state: String,
    pub latest: Option<SpeedSample>,
    pub latest_in_current_turn: bool,
    pub recent_average_tps: Option<f64>,
    pub sample_count: usize,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpeedSnapshot {
    pub sessions: Vec<SpeedSession>,
    pub checked_at: i64,
    pub partial: bool,
}

#[derive(Debug, Clone, Default)]
struct SessionMeta {
    id: String,
    project: String,
    subagent: bool,
}

#[derive(Default)]
struct Parser {
    meta: SessionMeta,
    model: Option<String>,
    turn_id: Option<String>,
    in_turn: bool,
    synchronized: bool,
    intervals: Vec<(i64, i64)>,
    bad_timing: bool,
    seen_items: VecDeque<String>,
    seen_usage: VecDeque<(u64, u64, u64)>,
    seen_responses: VecDeque<String>,
    latest: Option<SpeedSample>,
    samples: VecDeque<SpeedSample>,
    last_event_at: Option<i64>,
    unavailable_reason: Option<String>,
}

fn remember<T: PartialEq>(queue: &mut VecDeque<T>, value: T) {
    if !queue.contains(&value) {
        queue.push_back(value);
        if queue.len() > 256 {
            queue.pop_front();
        }
    }
}

/// Merge overlapping model windows. Never bridge gaps occupied by tools/user input.
fn model_duration(intervals: &mut [(i64, i64)]) -> i64 {
    intervals.sort_unstable();
    let mut total = 0;
    let mut window: Option<(i64, i64)> = None;
    for &(start, end) in intervals.iter() {
        match window {
            Some((a, b)) if start <= b => window = Some((a, b.max(end))),
            Some((a, b)) => {
                total += b - a;
                window = Some((start, end));
            }
            None => window = Some((start, end)),
        }
    }
    total + window.map_or(0, |(a, b)| b - a)
}

impl Parser {
    fn gap(&mut self) {
        self.synchronized = false;
        self.intervals.clear();
        self.bad_timing = false;
    }

    fn change_model(&mut self, model: &str) {
        if self.model.as_deref() != Some(model) {
            self.model = Some(model.chars().take(160).collect());
            self.samples.clear();
            self.latest = None;
            self.intervals.clear();
            self.bad_timing = false;
            self.unavailable_reason = None;
        }
    }

    fn feed_line(&mut self, line: &[u8]) {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            self.gap();
            return;
        };
        let p = &value["payload"];
        let at = value["timestamp"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis());
        if let Some(at) = at {
            self.last_event_at = Some(self.last_event_at.unwrap_or(at).max(at));
        }
        match value["type"].as_str().unwrap_or("") {
            "turn_context" => {
                if let Some(model) = p["model"].as_str().filter(|m| !m.is_empty()) {
                    self.change_model(model);
                }
            }
            "compacted" => self.gap(),
            "token_usage_record" => {
                self.accept_usage(
                    &p["usage"],
                    &p["thread_token_usage"],
                    p["response_id"].as_str(),
                    p["turn_id"].as_str(),
                    at,
                );
            }
            "event_msg" => match p["type"].as_str().unwrap_or("") {
                "task_started" | "turn_started" => {
                    self.turn_id = p["turn_id"].as_str().map(str::to_owned);
                    self.in_turn = true;
                    self.intervals.clear();
                    self.bad_timing = false;
                    self.synchronized = true;
                    self.unavailable_reason = None;
                }
                "task_complete" | "turn_complete" | "turn_aborted" => {
                    // A late completion from another turn must not stop the current turn.
                    if p["turn_id"].as_str().is_none()
                        || p["turn_id"].as_str() == self.turn_id.as_deref()
                    {
                        self.in_turn = false;
                    }
                }
                "model_reroute" => {
                    if let Some(model) = p["to_model"].as_str() {
                        self.change_model(model);
                    }
                }
                "context_compacted" | "thread_rolled_back" => self.gap(),
                "token_count" => {
                    // Null-info rate-limit notifications are not response completions.
                    if p["info"].is_object() {
                        self.accept_usage(
                            &p["info"]["last_token_usage"],
                            &p["info"]["total_token_usage"],
                            None,
                            None,
                            at,
                        );
                    }
                }
                "item_completed" => self.accept_item(p),
                _ => {}
            },
            // Prompt/answer/tool text is neither retained nor exposed to the frontend.
            _ => {}
        }
    }

    fn accept_item(&mut self, p: &Value) {
        let item = &p["item"];
        if !matches!(
            item["type"].as_str(),
            Some("Reasoning" | "AgentMessage" | "reasoning" | "agent_message")
        ) {
            return;
        }
        let turn = p["turn_id"].as_str();
        if turn.is_some() && turn != self.turn_id.as_deref() {
            self.gap();
            self.turn_id = turn.map(str::to_owned);
        }
        let key = item["id"]
            .as_str()
            .map(|id| format!("{}:{id}", turn.unwrap_or("")));
        if key.as_ref().is_some_and(|k| self.seen_items.contains(k)) {
            return;
        }
        if let Some(key) = key {
            remember(&mut self.seen_items, key);
        }
        self.in_turn = true;
        match (p["started_at_ms"].as_i64(), p["completed_at_ms"].as_i64()) {
            (Some(start), Some(end))
                if start > 0
                    && end > start
                    && end - start <= 3_600_000
                    && self.intervals.len() < 256 =>
            {
                self.intervals.push((start, end));
            }
            _ => self.bad_timing = true,
        }
    }

    fn accept_usage(
        &mut self,
        usage: &Value,
        cumulative: &Value,
        response: Option<&str>,
        turn: Option<&str>,
        at: Option<i64>,
    ) {
        let cumulative_key = cumulative["input_tokens"]
            .as_u64()
            .zip(cumulative["output_tokens"].as_u64())
            .zip(cumulative["total_tokens"].as_u64())
            .map(|((input, output), total)| (input, output, total));
        // Use cumulative counters / response IDs, NOT just per-response token counts:
        // two different responses can legitimately have identical usage.
        let duplicate = cumulative_key
            .as_ref()
            .is_some_and(|k| self.seen_usage.contains(k))
            || response.is_some_and(|id| self.seen_responses.iter().any(|old| old == id));
        if let Some(key) = cumulative_key {
            remember(&mut self.seen_usage, key);
        }
        if let Some(id) = response {
            remember(&mut self.seen_responses, id.to_owned());
        }
        if duplicate {
            return;
        }
        if turn.is_some() && turn != self.turn_id.as_deref() {
            self.gap();
            self.turn_id = turn.map(str::to_owned);
        }
        let mut intervals = std::mem::take(&mut self.intervals);
        let duration = model_duration(&mut intervals);
        let output = usage["output_tokens"].as_u64();
        let reasoning = usage["reasoning_output_tokens"].as_u64().unwrap_or(0);
        let reason = if !self.synchronized {
            Some("partial_response")
        } else if self.model.is_none() {
            Some("model_unavailable")
        } else if output.is_none()
            || (cumulative_key.is_none() && response.is_none())
            || at.is_none()
        {
            Some("usage_unavailable")
        } else if output == Some(0) {
            Some("no_output")
        } else if self.bad_timing || duration <= 0 || reasoning > output.unwrap_or(0) {
            Some("timing_unavailable")
        } else if duration < MIN_WINDOW_MS {
            Some("short_window")
        } else {
            None
        };
        self.synchronized = true;
        self.bad_timing = false;
        self.unavailable_reason = reason.map(str::to_owned);
        if reason.is_some() {
            return;
        }
        let output = output.unwrap_or(0);
        let tps = output as f64 * 1000.0 / duration as f64;
        if !tps.is_finite() || tps <= 0.0 || tps > 100_000.0 {
            self.unavailable_reason = Some("timing_unavailable".into());
            return;
        }
        let sample = SpeedSample {
            tokens_per_second: tps,
            output_tokens: output,
            // Reasoning is already INCLUDED in output_tokens; never add it again.
            reasoning_output_tokens: reasoning,
            model_time_ms: duration as u64,
            completed_at: at.unwrap_or(0),
            turn_id: self.turn_id.clone(),
        };
        self.latest = Some(sample.clone());
        self.samples.push_back(sample);
        if self.samples.len() > RECENT_SAMPLES {
            self.samples.pop_front();
        }
    }

    fn snapshot(&self, updated_at: i64, now: i64) -> SpeedSession {
        // Windows may defer LastWriteTime until an open writer closes its handle.
        let updated_at = updated_at.max(self.last_event_at.unwrap_or(0));
        let time: u64 = self.samples.iter().map(|s| s.model_time_ms).sum();
        let output: f64 = self.samples.iter().map(|s| s.output_tokens as f64).sum();
        let state = if now.saturating_sub(updated_at) > STALE_AFTER_MS {
            "stale"
        } else if !self.in_turn {
            "idle"
        } else if self
            .latest
            .as_ref()
            .is_some_and(|s| s.turn_id == self.turn_id)
        {
            "observed"
        } else {
            "waiting"
        };
        SpeedSession {
            id: self.meta.id.clone(),
            project: self.meta.project.clone(),
            model: self.model.clone(),
            updated_at,
            state: state.into(),
            latest: self.latest.clone(),
            latest_in_current_turn: self
                .latest
                .as_ref()
                .is_some_and(|s| s.turn_id.is_some() && s.turn_id == self.turn_id),
            // Weighted mean avoids short, unusually fast responses dominating the result.
            recent_average_tps: (time > 0).then(|| output * 1000.0 / time as f64),
            sample_count: self.samples.len(),
            unavailable_reason: self.unavailable_reason.clone(),
        }
    }
}

struct TailReader {
    parser: Parser,
    offset: u64,
    pending: Vec<u8>,
    dropping_line: bool,
    modified: Option<SystemTime>,
}

fn read_meta(path: &Path) -> std::io::Result<SessionMeta> {
    let mut bytes = Vec::new();
    BufReader::new(File::open(path)?.take(MAX_LINE_BYTES as u64)).read_until(b'\n', &mut bytes)?;
    let line = bytes.split(|b| *b == b'\n').next().unwrap_or(&[]);
    let value = serde_json::from_slice::<Value>(line).unwrap_or(Value::Null);
    let p = &value["payload"];
    let id = p["id"]
        .as_str()
        .or_else(|| p["session_id"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let project = p["cwd"]
        .as_str()
        .and_then(|cwd| cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next())
        .filter(|s| !s.is_empty())
        .unwrap_or("Codex")
        .chars()
        .take(100)
        .collect();
    let subagent = p["source"].get("subagent").is_some()
        || p["thread_source"].get("subagent").is_some()
        || p["source"].as_str() == Some("subagent")
        || p["thread_source"]["type"].as_str() == Some("subagent");
    Ok(SessionMeta {
        id,
        project,
        subagent,
    })
}

impl TailReader {
    fn new(meta: SessionMeta) -> Self {
        Self {
            parser: Parser {
                meta,
                ..Default::default()
            },
            offset: 0,
            pending: Vec::new(),
            dropping_line: false,
            modified: None,
        }
    }

    fn feed_bytes(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if byte == b'\n' {
                if !self.dropping_line && !self.pending.is_empty() {
                    self.parser.feed_line(&self.pending);
                }
                self.pending.clear();
                self.dropping_line = false;
            } else if !self.dropping_line {
                if self.pending.len() >= MAX_LINE_BYTES {
                    self.pending.clear();
                    self.dropping_line = true;
                    self.parser.gap();
                } else {
                    self.pending.push(byte);
                }
            }
        }
    }

    fn update(&mut self, path: &Path) -> std::io::Result<()> {
        let mut file = File::open(path)?;
        let meta = file.metadata()?;
        let modified = meta.modified()?;
        let len = meta.len();
        let reload = self.modified.is_none()
            || len < self.offset
            || (len == self.offset && self.modified != Some(modified));
        if reload {
            let mut window = TAIL_BYTES;
            loop {
                let start = len.saturating_sub(window);
                let session_meta = self.parser.meta.clone();
                self.parser = Parser {
                    meta: session_meta,
                    synchronized: start == 0,
                    ..Default::default()
                };
                self.pending.clear();
                // The first line in a tail can be a partial UTF-8/JSON record. Skip it.
                self.dropping_line = start > 0;
                file.seek(SeekFrom::Start(start))?;
                let mut bytes = Vec::new();
                (&mut file).take(len - start).read_to_end(&mut bytes)?;
                self.feed_bytes(&bytes);
                self.offset = start + bytes.len() as u64;
                if self.parser.model.is_some() || start == 0 || window >= MAX_TAIL_BYTES {
                    break;
                }
                window *= 2;
            }
        } else if len > self.offset {
            file.seek(SeekFrom::Start(self.offset))?;
            let mut bytes = Vec::new();
            (&mut file)
                .take((len - self.offset).min(TAIL_BYTES))
                .read_to_end(&mut bytes)?;
            self.feed_bytes(&bytes);
            self.offset += bytes.len() as u64;
        }
        self.modified = Some(modified);
        Ok(())
    }
}

#[derive(Default)]
struct Monitor {
    home: PathBuf,
    paths: Vec<PathBuf>,
    readers: HashMap<PathBuf, TailReader>,
    last_scan: Option<Instant>,
    partial: bool,
}

fn discover(
    path: &Path,
    depth: usize,
    budget: &mut usize,
    files: &mut Vec<(PathBuf, SystemTime)>,
    partial: &mut bool,
) {
    if depth > 5 || *budget == 0 {
        *partial = true;
        return;
    }
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            *partial = true;
            return;
        }
    };
    for entry in entries {
        if *budget == 0 {
            *partial = true;
            break;
        }
        *budget -= 1;
        let Ok(entry) = entry else {
            *partial = true;
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            *partial = true;
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            discover(&path, depth + 1, budget, files, partial);
        } else if kind.is_file()
            && path.extension().is_some_and(|e| e == "jsonl")
            && entry.file_name().to_string_lossy().starts_with("rollout-")
        {
            match entry.metadata().and_then(|m| m.modified()) {
                Ok(time) => files.push((path, time)),
                Err(_) => *partial = true,
            }
        }
    }
}

fn unix_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

impl Monitor {
    fn update(&mut self, home: &Path) -> SpeedSnapshot {
        if self.home != home {
            *self = Self {
                home: home.to_owned(),
                ..Default::default()
            };
        }
        if self
            .last_scan
            .is_none_or(|t| t.elapsed() >= Duration::from_secs(10))
        {
            let mut candidates = Vec::new();
            self.partial = false;
            discover(
                &home.join("sessions"),
                0,
                &mut 20_000,
                &mut candidates,
                &mut self.partial,
            );
            candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            self.paths.clear();
            // Bound startup even when an installation has thousands of historical agents.
            for (path, _) in candidates.into_iter().take(64) {
                if !self.readers.contains_key(&path) {
                    match read_meta(&path) {
                        Ok(meta) if !meta.subagent => {
                            self.readers.insert(path.clone(), TailReader::new(meta));
                        }
                        Ok(_) => continue,
                        Err(_) => {
                            self.partial = true;
                            continue;
                        }
                    }
                }
                self.paths.push(path);
                if self.paths.len() == MAX_SESSIONS {
                    break;
                }
            }
            self.readers.retain(|p, _| self.paths.contains(p));
            self.last_scan = Some(Instant::now());
        }
        let now = Utc::now().timestamp_millis();
        let mut partial = self.partial;
        let mut sessions = Vec::new();
        for path in &self.paths {
            if let Some(reader) = self.readers.get_mut(path) {
                match reader.update(path) {
                    Ok(()) => sessions.push(
                        reader
                            .parser
                            .snapshot(unix_ms(reader.modified.unwrap_or(UNIX_EPOCH)), now),
                    ),
                    Err(_) => partial = true,
                }
            }
        }
        sessions.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        SpeedSnapshot {
            sessions,
            checked_at: now,
            partial,
        }
    }
}

/// Also used by the local, metadata-only diagnostic example.
pub fn read_snapshot() -> Result<SpeedSnapshot, String> {
    static MONITOR: OnceLock<Mutex<Monitor>> = OnceLock::new();
    let home = std::env::var_os("CODEX_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".codex")))
        .ok_or_else(|| "Codex home is unavailable".to_string())?;
    let mut monitor = MONITOR
        .get_or_init(|| Mutex::new(Monitor::default()))
        .lock()
        .map_err(|_| "Could not read Codex speed statistics".to_string())?;
    Ok(monitor.update(&home))
}

#[tauri::command]
pub async fn get_token_speed_snapshot() -> Result<SpeedSnapshot, String> {
    tokio::task::spawn_blocking(read_snapshot)
        .await
        .map_err(|_| "Could not read Codex speed statistics".to_string())?
}

#[cfg(test)]
#[path = "token_speed_tests.rs"]
mod tests;
