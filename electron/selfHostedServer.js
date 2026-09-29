import fs from 'node:fs/promises';
import path from 'node:path';

import { isCloudCliServer } from './localServer.js';

// A self-hosted CloudCLI server on another machine that this desktop app opens
// as a client (upstream issue siteboon/claudecodeui#940). Unlike Local CloudCLI,
// the app never installs or starts anything for it: the server is only probed
// and loaded.
//
// Where the URL comes from, first match wins:
//   1. CLOUDCLI_DESKTOP_SERVER_URL in the environment (development, scripts);
//   2. <userData>/self-hosted-server.json, so a user can repoint an installed
//      app without rebuilding or re-signing it;
//   3. electron/self-hosted-server.json inside the app, written at build time
//      by scripts/release/prepare-desktop-app.js from
//      CLOUDCLI_DESKTOP_BUNDLED_SERVER_URL.
// Both files hold {"url": "https://host[:port]"}.

export const SELF_HOSTED_SERVER_ENV_KEY = 'CLOUDCLI_DESKTOP_SERVER_URL';
export const SELF_HOSTED_SERVER_FILE_NAME = 'self-hosted-server.json';
const PROBE_TIMEOUT_MS = 8000;

/**
 * Reduces a configured value to the origin the app loads, or null when the
 * value is not an http(s) URL of a site root. A path is refused rather than
 * dropped: CloudCLI serves its UI, API and WebSockets from the root of its
 * origin, so `https://host/cloudcli` would silently open whatever else lives
 * at `https://host/`.
 */
export function normalizeServerUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.pathname !== '/') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

async function readServerFile(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }

  const url = normalizeServerUrl(parsed?.url);
  if (!url) {
    throw new Error(`${filePath} must contain {"url": "https://host[:port]"} with no path; found ${JSON.stringify(parsed?.url ?? null)}.`);
  }
  return url;
}

/**
 * Returns {url, name, source} for the configured server, or null when none is
 * configured. A value that is present but malformed throws, so a typo surfaces
 * as an error instead of silently falling back to a different server.
 */
export async function resolveSelfHostedServer({ env = process.env, userDataPath, appRoot }) {
  const fromEnv = env[SELF_HOSTED_SERVER_ENV_KEY];
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    const url = normalizeServerUrl(fromEnv);
    if (!url) {
      throw new Error(`${SELF_HOSTED_SERVER_ENV_KEY} must be an http(s) URL with no path; found ${JSON.stringify(fromEnv)}.`);
    }
    return describe(url, SELF_HOSTED_SERVER_ENV_KEY);
  }

  const candidates = [
    userDataPath ? path.join(userDataPath, SELF_HOSTED_SERVER_FILE_NAME) : null,
    appRoot ? path.join(appRoot, 'electron', SELF_HOSTED_SERVER_FILE_NAME) : null,
  ].filter(Boolean);

  for (const filePath of candidates) {
    const url = await readServerFile(filePath);
    if (url) return describe(url, filePath);
  }
  return null;
}

function describe(url, source) {
  return { url, name: new URL(url).host, source };
}

/** True when the configured server answers CloudCLI's /health. */
export function probeSelfHostedServer(url, timeoutMs = PROBE_TIMEOUT_MS) {
  return isCloudCliServer(url, timeoutMs);
}

/** The origins the app treats as its own when a self-hosted server is set. */
export function getSelfHostedOrigins(server) {
  return server?.url ? [server.url] : [];
}
