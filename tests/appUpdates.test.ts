import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  checkForAppUpdate, isNewerStableVersion, parseAppRelease,
  UPDATE_API_URL, UPDATE_RELEASES_URL, UPDATE_REPOSITORY,
} from "../src/lib/appUpdates.ts";

const current = "0.2.16";
const fixture = (overrides: Record<string, unknown> = {}) => ({
  tag_name: "v0.2.17", draft: false, prerelease: false,
  html_url: `${UPDATE_RELEASES_URL}/tag/v0.2.17`, body: "改进额度圆环和更新来源",
  ...overrides,
});
const response = (payload: unknown, status = 200): typeof fetch =>
  async () => new Response(status === 204 ? null : JSON.stringify(payload), { status });

test("numeric version comparison supports higher patch/minor/major and never downgrades", () => {
  for (const next of ["0.2.17", "v0.2.100", "0.10.0", "1.0.0"]) {
    assert.equal(isNewerStableVersion(next, current), true, next);
  }
  for (const next of ["0.2.16", "0.2.15", "0.1.999", "0.2.16+other"]) {
    assert.equal(isNewerStableVersion(next, current), false, next);
  }
  assert.equal(isNewerStableVersion("0.2.17", "0.2.17-beta.1"), true);
  assert.equal(isNewerStableVersion("v0.2.17+build.2", "0.2.16+build.99"), true);
});

test("malformed and prerelease candidates are excluded", () => {
  for (const bad of ["latest", "", "0.02.17", "0.2", "v0.2.17-beta.1", "0.2.17\n", "999999999999999999.0.0", "0.2.17-01"]) {
    assert.equal(isNewerStableVersion(bad, current), false, bad);
  }
  assert.equal(isNewerStableVersion("1.0.0", "invalid"), false);
});

test("release metadata is accepted only for a newer stable release in this fork", () => {
  assert.deepEqual(parseAppRelease(fixture(), current), {
    version: "0.2.17", body: "改进额度圆环和更新来源", url: `${UPDATE_RELEASES_URL}/tag/v0.2.17`,
  });
  for (const value of [null, {}, fixture({ draft: true }), fixture({ prerelease: true }),
    fixture({ draft: undefined }), fixture({ tag_name: "v0.2.16" })]) {
    assert.equal(parseAppRelease(value, current), null);
  }
  assert.equal(parseAppRelease(fixture({ body: null }), current)?.body, "");
  assert.equal(parseAppRelease(fixture({ body: "x".repeat(20_000) }), current)?.body.length, 10_000);
});

test("rejects upstream, foreign, credentialed and malformed release links", () => {
  for (const url of [
    "https://github.com/Lampese/codex-switcher/releases/tag/v0.2.17",
    "https://github.com/another/repo/releases/tag/v0.2.17",
    "https://github.com.evil.invalid/csdjk/codex-switcher/releases/tag/v0.2.17",
    "https://github.com@evil.invalid/csdjk/codex-switcher/releases/tag/v0.2.17",
    "https://user:pass@github.com/csdjk/codex-switcher/releases/tag/v0.2.17",
    "http://github.com/csdjk/codex-switcher/releases/tag/v0.2.17",
    `${UPDATE_RELEASES_URL}/tag/v0.2.18`, `${UPDATE_RELEASES_URL}/tag/v0.2.17?redirect=elsewhere`,
    `${UPDATE_RELEASES_URL}/tag/%E0%A4`, "javascript:alert(1)", "not a URL",
  ]) assert.equal(parseAppRelease(fixture({ html_url: url }), current), null, url);
});

test("queries only this fork without credentials and refuses automatic redirects", async () => {
  const calls: Array<{ url: unknown; options: RequestInit | undefined }> = [];
  const fetcher: typeof fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(fixture()), { status: 200 });
  };
  assert.equal((await checkForAppUpdate(current, undefined, fetcher))?.version, "0.2.17");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, UPDATE_API_URL);
  assert.equal(calls[0].options?.credentials, "omit");
  assert.equal(calls[0].options?.redirect, "error");
  assert.equal(new Headers(calls[0].options?.headers).has("Authorization"), false);
});

test("no release or no newer version produces no banner", async () => {
  assert.equal(await checkForAppUpdate(current, undefined, response(null, 404)), null);
  assert.equal(await checkForAppUpdate(current, undefined, response(null, 204)), null);
  assert.equal(await checkForAppUpdate(current, undefined, response(fixture({ tag_name: "v0.2.16" }))), null);
});

test("rate limits, server failures and invalid JSON do not fall back to upstream", async () => {
  for (const status of [403, 429, 500]) {
    let requests = 0;
    const fetcher: typeof fetch = async () => { requests++; return new Response("unavailable", { status }); };
    await assert.rejects(checkForAppUpdate(current, undefined, fetcher), new RegExp(`HTTP ${status}`));
    assert.equal(requests, 1);
  }
  await assert.rejects(checkForAppUpdate(current, undefined, async () => new Response("not JSON")));
});

test("component cleanup cancels in-flight checks", async () => {
  const controller = new AbortController();
  const fetcher: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
    if (options?.signal?.aborted) rejectAbort();
    else options?.signal?.addEventListener("abort", rejectAbort, { once: true });
  });
  const pending = checkForAppUpdate(current, controller.signal, fetcher);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(checkForAppUpdate(current, controller.signal, fetcher), { name: "AbortError" });
});

test("installed config cannot silently re-enable unsigned or upstream installation", () => {
  const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  const ci = JSON.parse(read("src-tauri/tauri.ci.conf.json"));
  const caps = JSON.parse(read("src-tauri/capabilities/default.json"));
  assert.equal(config.plugins?.updater, undefined);
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(ci.bundle.createUpdaterArtifacts, false);
  assert.ok(!caps.permissions.some((p: string) => p.startsWith("updater:")));
  assert.doesNotMatch(read("src-tauri/src/lib.rs"), /tauri_plugin_updater::/);
  assert.doesNotMatch(read("src/components/UpdateChecker.tsx"), /downloadAndInstall|plugin-updater|Lampese/);
  assert.equal(UPDATE_REPOSITORY, "csdjk/codex-switcher");
});
