import test from "node:test";
import assert from "node:assert/strict";
import { compareAccounts, remainingQuota } from "../src/lib/usageModel.ts";
import { getAutoWarmupWindow } from "../src/lib/autoWarmupPolicy.ts";
import type { AccountWithUsage, UsageInfo } from "../src/types/index.ts";

const usage = (primary: number | null, secondary: number | null, extra = {}) => ({
  primary_used_percent: primary, secondary_used_percent: secondary, error: null, ...extra,
} as UsageInfo);
const account = (id: string, value?: UsageInfo) => ({ id, name: id, usage: value } as AccountWithUsage);

test("remaining quota respects the bottleneck, clamping, and missing values", () => {
  assert.equal(remainingQuota(usage(0, 100)), 0);
  assert.equal(remainingQuota(usage(null, 40)), 60);
  assert.equal(remainingQuota(usage(-2, 101)), 0);
  assert.equal(remainingQuota(usage(NaN, null)), null);
  assert.equal(remainingQuota(usage(0, 0, {error: "offline"})), null);
});
test("remaining sorts put fresh results first, then cached, then unknown in both directions", () => {
  const entries = [account("unknown"), account("cached", usage(0, 0, {cached:true})),
    account("exhausted", usage(0, 100)), account("available", usage(40, 20))];
  assert.deepEqual([...entries].sort((a,b) => compareAccounts(a,b,"remaining_desc")).map(a=>a.id),
    ["available", "exhausted", "cached", "unknown"]);
  assert.deepEqual([...entries].sort((a,b) => compareAccounts(a,b,"remaining_asc")).map(a=>a.id),
    ["exhausted", "available", "cached", "unknown"]);
});
test("missing dates sort last and ties never produce NaN", () => {
  const a = account("a"), b = account("b");
  for (const sort of ["remaining_asc","remaining_desc","deadline_asc","deadline_desc","subscription_asc","subscription_desc"]) {
    assert.ok(compareAccounts(a,b,sort)<0,sort);
  }
  b.usage = usage(1,2,{primary_resets_at:100});
  assert.ok(compareAccounts(a,b,"deadline_desc")>0);
});
test("cached data cannot trigger automatic warm-up even with a fresh-looking reset", () => {
  const fresh = usage(0, 10, {primary_resets_at: Math.floor(Date.now()/1000)+18000, primary_window_minutes:300});
  assert.ok(getAutoWarmupWindow(fresh));
  assert.equal(getAutoWarmupWindow({...fresh,cached:true}),null);
});
