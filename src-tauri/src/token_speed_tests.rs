use super::*;
use serde_json::json;
use std::io::Write;

fn feed(p: &mut Parser, kind: &str, payload: Value) {
    p.feed_line(
        json!({"timestamp":"2026-10-16T00:00:00Z","type":kind,"payload":payload})
            .to_string()
            .as_bytes(),
    );
}
fn parser() -> Parser {
    let mut p = Parser::default();
    feed(
        &mut p,
        "event_msg",
        json!({"type":"task_started","turn_id":"turn-1"}),
    );
    feed(&mut p, "turn_context", json!({"model":"test-model"}));
    p
}
fn item(p: &mut Parser, id: &str, kind: &str, start: i64, end: i64) {
    feed(
        p,
        "event_msg",
        json!({"type":"item_completed","turn_id":"turn-1","item":{"id":id,"type":kind},"started_at_ms":start,"completed_at_ms":end}),
    );
}
fn usage(output: u64, reasoning: u64) -> Value {
    json!({"input_tokens":1000,"cached_input_tokens":500,"output_tokens":output,"reasoning_output_tokens":reasoning,"total_tokens":1000+output})
}
fn cumulative(n: u64, output: u64) -> Value {
    json!({"input_tokens":n*1000,"output_tokens":output,"total_tokens":n*1000+output})
}
fn modern(p: &mut Parser, id: &str, output: u64, reasoning: u64, total: Value) {
    feed(
        p,
        "token_usage_record",
        json!({"turn_id":"turn-1","response_id":id,"usage":usage(output,reasoning),"thread_token_usage":total}),
    );
}
fn legacy(p: &mut Parser, output: u64, reasoning: u64, total: Value) {
    feed(
        p,
        "event_msg",
        json!({"type":"token_count","info":{"last_token_usage":usage(output,reasoning),"total_token_usage":total}}),
    );
}

#[test]
fn excludes_tool_runtime_and_does_not_double_count_reasoning() {
    let mut p = parser();
    item(&mut p, "r", "Reasoning", 1000, 5000);
    item(&mut p, "tool", "CommandExecution", 5000, 25000);
    item(&mut p, "a", "AgentMessage", 25000, 28000);
    modern(&mut p, "res-1", 1400, 800, cumulative(1, 1400));
    let s = p.latest.unwrap();
    assert_eq!(s.model_time_ms, 7000);
    assert_eq!(s.output_tokens, 1400);
    assert_eq!(s.tokens_per_second, 200.0);
}

#[test]
fn overlapping_and_duplicate_items_are_unioned() {
    let mut p = parser();
    item(&mut p, "a", "Reasoning", 1000, 6000);
    item(&mut p, "b", "AgentMessage", 5000, 11000);
    item(&mut p, "b", "AgentMessage", 5000, 11000);
    modern(&mut p, "res", 1000, 0, cumulative(1, 1000));
    assert_eq!(p.latest.unwrap().model_time_ms, 10000);
}

#[test]
fn both_usage_carriers_count_once_and_do_not_consume_next_windows() {
    let mut p = parser();
    item(&mut p, "a", "AgentMessage", 1000, 3000);
    modern(&mut p, "r1", 100, 0, cumulative(1, 100));
    item(&mut p, "b", "AgentMessage", 5000, 7000);
    legacy(&mut p, 100, 0, cumulative(1, 100));
    modern(&mut p, "r2", 100, 0, cumulative(2, 200));
    legacy(&mut p, 100, 0, cumulative(2, 200));
    assert_eq!(p.samples.len(), 2); // Identical individual usage, different cumulative counts.
    assert_eq!(p.latest.unwrap().tokens_per_second, 50.0);
}

#[test]
fn legacy_only_and_reverse_order_carriers_are_supported() {
    let mut p = parser();
    item(&mut p, "a", "AgentMessage", 1000, 3000);
    legacy(&mut p, 100, 0, cumulative(1, 100));
    modern(&mut p, "r1", 100, 0, cumulative(1, 100));
    assert_eq!(p.samples.len(), 1);
    assert_eq!(p.latest.unwrap().tokens_per_second, 50.0);
}

#[test]
fn no_timing_tiny_windows_and_negative_usage_never_fabricate_speed() {
    let mut p = parser();
    legacy(&mut p, 100, 0, cumulative(1, 100));
    assert!(p.latest.is_none());
    item(&mut p, "short", "AgentMessage", 1000, 1010);
    legacy(&mut p, 100, 0, cumulative(2, 200));
    assert_eq!(p.unavailable_reason.as_deref(), Some("short_window"));
    item(&mut p, "negative", "AgentMessage", 2000, 3000);
    feed(
        &mut p,
        "token_usage_record",
        json!({"response_id":"bad","usage":{"output_tokens":-1}}),
    );
    assert!(p.latest.is_none());
}

#[test]
fn incomplete_tail_discards_first_response_then_recovers() {
    let mut p = parser();
    p.synchronized = false;
    item(&mut p, "a", "AgentMessage", 1000, 3000);
    modern(&mut p, "r1", 100, 0, cumulative(1, 100));
    assert_eq!(p.unavailable_reason.as_deref(), Some("partial_response"));
    item(&mut p, "b", "AgentMessage", 4000, 6000);
    modern(&mut p, "r2", 100, 0, cumulative(2, 200));
    assert_eq!(p.latest.unwrap().tokens_per_second, 50.0);
}

#[test]
fn model_switch_resets_samples_and_unknown_model_is_not_guessed() {
    let mut p = parser();
    item(&mut p, "a", "AgentMessage", 1000, 3000);
    modern(&mut p, "r1", 100, 0, cumulative(1, 100));
    feed(&mut p, "turn_context", json!({"model":"another-model"}));
    assert!(p.latest.is_none());
    assert!(p.samples.is_empty());
    p.model = None;
    item(&mut p, "b", "AgentMessage", 4000, 6000);
    modern(&mut p, "r2", 100, 0, cumulative(2, 200));
    assert_eq!(p.unavailable_reason.as_deref(), Some("model_unavailable"));
}

#[test]
fn weighted_average_and_recent_sample_bound() {
    let mut p = parser();
    item(&mut p, "a", "AgentMessage", 1000, 2000);
    modern(&mut p, "r1", 100, 0, cumulative(1, 100));
    item(&mut p, "b", "AgentMessage", 3000, 12000);
    modern(&mut p, "r2", 90, 0, cumulative(2, 190));
    assert_eq!(p.snapshot(100, 100).recent_average_tps, Some(19.0));
    for n in 3..12 {
        item(
            &mut p,
            &format!("i{n}"),
            "AgentMessage",
            13000 + n as i64 * 2000,
            14000 + n as i64 * 2000,
        );
        modern(&mut p, &format!("r{n}"), 100, 0, cumulative(n, n * 100));
    }
    assert_eq!(p.samples.len(), RECENT_SAMPLES);
}

#[test]
fn quota_only_events_do_not_consume_pending_output() {
    let mut p = parser();
    item(&mut p, "a", "AgentMessage", 1000, 3000);
    feed(
        &mut p,
        "event_msg",
        json!({"type":"token_count","info":null,"rate_limits":{}}),
    );
    modern(&mut p, "r1", 100, 0, cumulative(1, 100));
    assert_eq!(p.latest.unwrap().tokens_per_second, 50.0);
}

#[test]
fn compaction_discards_uncertain_boundary_and_recovers() {
    let mut p = parser();
    item(&mut p, "a", "AgentMessage", 1000, 3000);
    feed(&mut p, "compacted", json!({}));
    modern(&mut p, "compact", 100, 0, cumulative(1, 100));
    assert!(p.latest.is_none());
    item(&mut p, "b", "AgentMessage", 4000, 6000);
    modern(&mut p, "r2", 100, 0, cumulative(2, 200));
    assert_eq!(p.latest.unwrap().tokens_per_second, 50.0);
}

#[test]
fn old_result_is_explicitly_marked_when_new_turn_starts_or_session_is_stale() {
    let mut p = parser();
    item(&mut p, "a", "AgentMessage", 1000, 3000);
    modern(&mut p, "r1", 100, 0, cumulative(1, 100));
    feed(
        &mut p,
        "event_msg",
        json!({"type":"task_complete","turn_id":"turn-1"}),
    );
    assert_eq!(p.snapshot(1000, 1000).state, "idle");
    feed(
        &mut p,
        "event_msg",
        json!({"type":"task_started","turn_id":"turn-2"}),
    );
    let s = p.snapshot(1000, 1000);
    assert_eq!(s.state, "waiting");
    assert!(!s.latest_in_current_turn);
    let last_event = p.last_event_at.unwrap();
    assert_eq!(p.snapshot(last_event, last_event + 200000).state, "stale");
}

fn temp_dir() -> PathBuf {
    let p = std::env::temp_dir().join(format!("codex-speed-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&p).unwrap();
    p
}
fn fixture_lines() -> String {
    [
        json!({"type":"session_meta","payload":{"id":"test-session","cwd":"C:/project/demo","source":"cli"}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}),
        json!({"type":"turn_context","payload":{"model":"test-model"}}),
        json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":"turn-1","item":{"id":"a","type":"AgentMessage"},"started_at_ms":1000,"completed_at_ms":3000}}),
        json!({"timestamp":"2026-10-16T00:00:00Z","type":"token_usage_record","payload":{"turn_id":"turn-1","response_id":"r1","usage":usage(100,0),"thread_token_usage":cumulative(1,100)}}),
    ].iter().map(|v|format!("{v}\n")).collect()
}

#[test]
fn reader_handles_partial_json_append_and_truncation() {
    let root = temp_dir();
    let path = root.join("rollout-test.jsonl");
    let fixture = fixture_lines();
    let split = fixture.len() - 12;
    fs::write(&path, &fixture[..split]).unwrap();
    let mut reader = TailReader::new(read_meta(&path).unwrap());
    reader.update(&path).unwrap();
    assert!(reader.parser.latest.is_none());
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(fixture[split..].as_bytes()).unwrap();
    drop(file);
    reader.update(&path).unwrap();
    assert_eq!(
        reader.parser.latest.as_ref().unwrap().tokens_per_second,
        50.0
    );
    reader.update(&path).unwrap();
    assert_eq!(reader.parser.samples.len(), 1);
    fs::write(
        &path,
        b"{\"type\":\"turn_context\",\"payload\":{\"model\":\"new\"}}\n",
    )
    .unwrap();
    reader.update(&path).unwrap();
    assert!(reader.parser.latest.is_none());
    assert_eq!(reader.parser.model.as_deref(), Some("new"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn oversized_lines_are_bounded_and_a_following_turn_recovers() {
    let mut reader = TailReader::new(SessionMeta::default());
    reader.feed_bytes(&vec![b'x'; MAX_LINE_BYTES + 200]);
    assert!(reader.pending.len() <= MAX_LINE_BYTES);
    reader.feed_bytes(b"\n");
    reader.feed_bytes(fixture_lines().as_bytes());
    assert_eq!(reader.parser.latest.unwrap().tokens_per_second, 50.0);
}

#[test]
fn monitor_reads_only_rollouts_and_excludes_subagents() {
    let root = temp_dir();
    fs::create_dir_all(root.join("sessions/2026/10/16")).unwrap();
    fs::write(
        root.join("auth.json"),
        "DO NOT READ OR EXPOSE THIS SENTINEL",
    )
    .unwrap();
    fs::write(
        root.join("sessions/2026/10/16/rollout-main.jsonl"),
        fixture_lines(),
    )
    .unwrap();
    fs::write(
        root.join("sessions/2026/10/16/rollout-agent.jsonl"),
        fixture_lines().replace("\"source\":\"cli\"", "\"source\":{\"subagent\":{}}"),
    )
    .unwrap();
    let snapshot = Monitor::default().update(&root);
    assert_eq!(snapshot.sessions.len(), 1);
    assert_eq!(snapshot.sessions[0].model.as_deref(), Some("test-model"));
    assert_eq!(snapshot.sessions[0].project, "demo");
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains("SENTINEL"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_codex_home_is_an_empty_snapshot() {
    let root = temp_dir();
    assert!(Monitor::default().update(&root).sessions.is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_new_timing_retains_only_the_labeled_last_valid_sample() {
    let mut p = parser();
    item(&mut p, "valid", "AgentMessage", 1000, 3000);
    modern(&mut p, "r1", 100, 0, cumulative(1, 100));
    let recorded = p.latest.as_ref().unwrap().completed_at;
    modern(&mut p, "r2", 200, 0, cumulative(2, 300));
    assert_eq!(p.latest.as_ref().unwrap().tokens_per_second, 50.0);
    assert_eq!(p.latest.as_ref().unwrap().completed_at, recorded);
    assert_eq!(p.unavailable_reason.as_deref(), Some("timing_unavailable"));
    assert_eq!(p.samples.len(), 1);
    item(&mut p, "valid-again", "AgentMessage", 4000, 6000);
    modern(&mut p, "r3", 200, 0, cumulative(3, 500));
    assert_eq!(p.latest.as_ref().unwrap().tokens_per_second, 100.0);
    assert!(p.unavailable_reason.is_none());
}

#[test]
fn recorded_activity_wins_when_windows_defers_file_modified_time() {
    let mut p = parser();
    item(&mut p, "valid", "AgentMessage", 1000, 3000);
    modern(&mut p, "r1", 100, 0, cumulative(1, 100));
    let event_time = p.last_event_at.unwrap();
    let s = p.snapshot(event_time - 500000, event_time + 1000);
    assert_eq!(s.updated_at, event_time);
    assert_eq!(s.state, "observed");
}
