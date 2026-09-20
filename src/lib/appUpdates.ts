// This fork deliberately uses its own public Releases metadata, not the
// upstream signed updater. Keep every update URL derived from this constant.
export const UPDATE_REPOSITORY = "csdjk/codex-switcher";
export const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;
export const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
export const UPDATE_TIMEOUT_MS = 10_000;

export interface AppRelease {
  version: string;
  body: string;
  url: string;
}

interface Version {
  parts: [number, number, number];
  prerelease: boolean;
}

function parseVersion(value: string): Version | null {
  if (value.length > 128) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as Version["parts"];
  if (!parts.every(Number.isSafeInteger)) return null;
  // Numeric prerelease identifiers must not contain leading zeroes.
  if (match[4]?.split(".").some((part) => /^0\d+$/.test(part))) return null;
  return { parts, prerelease: Boolean(match[4]) };
}

/** Stable releases only; compare numeric components, never lexicographically. */
export function isNewerStableVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || next.prerelease || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next.parts[index] !== installed.parts[index]) {
      return next.parts[index] > installed.parts[index];
    }
  }
  // A stable release supersedes a prerelease of the same version.
  return installed.prerelease;
}

/** Accept only a release page in this fork, never URLs from another repository. */
export function parseAppRelease(payload: unknown, currentVersion: string): AppRelease | null {
  if (!payload || typeof payload !== "object") return null;
  const release = payload as Record<string, unknown>;
  if (release.draft !== false || release.prerelease !== false ||
      typeof release.tag_name !== "string" || typeof release.html_url !== "string" ||
      !isNewerStableVersion(release.tag_name, currentVersion)) return null;

  const canonicalUrl = `${UPDATE_RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`;
  try {
    const url = new URL(release.html_url);
    if (url.origin !== "https://github.com" || url.username || url.password ||
        url.search || url.hash ||
        decodeURIComponent(url.pathname) !== `/${UPDATE_REPOSITORY}/releases/tag/${release.tag_name}`) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    version: release.tag_name.replace(/^v/, ""),
    // Render notes as plain React text. Never inject remote HTML or Markdown.
    body: typeof release.body === "string" ? release.body.trim().slice(0, 10_000) : "",
    url: canonicalUrl,
  };
}

/** No credentials, no account data, no upstream fallback and no auto-install. */
export async function checkForAppUpdate(
  currentVersion: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<AppRelease | null> {
  if (!parseVersion(currentVersion)) throw new Error("Invalid installed application version");
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, UPDATE_TIMEOUT_MS);
  try {
    const response = await fetcher(UPDATE_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    // A repository without a public release should not display an error banner.
    if (response.status === 404 || response.status === 204) return null;
    if (!response.ok) {
      throw new Error(`Release check for ${UPDATE_REPOSITORY} failed (HTTP ${response.status})`);
    }
    return parseAppRelease(await response.json(), currentVersion);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
