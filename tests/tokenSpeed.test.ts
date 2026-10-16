import test from "node:test";
import assert from "node:assert/strict";
import { formatTokenSpeed, selectSpeedSession, type TokenSpeedSession } from "../src/lib/tokenSpeed.ts";

const session = (id: string): TokenSpeedSession => ({ id, project: "Fixture", model: "test-model", updated_at: 1000, state: "idle", latest: null, latest_in_current_turn: false, recent_average_tps: null, sample_count: 0, unavailable_reason: null });

test("speed display marks estimates and never shows NaN, Infinity, zero, or missing as a real speed", () => {
  assert.equal(formatTokenSpeed(42.36), "≈ 42.4");
  for (const value of [null, undefined, NaN, Infinity, -1, 0, 100001]) assert.equal(formatTokenSpeed(value), "--");
});

test("automatic selection follows recent ordering", () => {
  const snapshot = { sessions: [session("b"), session("a")], checked_at: 1000, partial: false };
  assert.equal(selectSpeedSession(snapshot, "auto")?.id, "b");
});

test("a pinned session never changes when another session becomes active", () => {
  const snapshot = { sessions: [session("b"), session("a")], checked_at: 1000, partial: false };
  assert.equal(selectSpeedSession(snapshot, "a")?.id, "a");
  snapshot.sessions.reverse();
  assert.equal(selectSpeedSession(snapshot, "a")?.id, "a");
});

test("missing or disconnected selections never silently substitute another session", () => {
  assert.equal(selectSpeedSession(null, "auto"), null);
  assert.equal(selectSpeedSession({ sessions: [], checked_at: 1000, partial: false }, "auto"), null);
  assert.equal(selectSpeedSession({ sessions: [session("b")], checked_at: 1000, partial: false }, "a"), null);
});
