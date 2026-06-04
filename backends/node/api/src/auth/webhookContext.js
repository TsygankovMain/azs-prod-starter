/**
 * webhookContext.js
 *
 * Builds a runtime "context" object for Bitrix24 INBOUND WEBHOOK access, used by
 * background tasks (plan generation, dispatch execution, reading/writing
 * app.option) that must work without a per-user OAuth session — i.e. after a
 * redeploy when nobody has opened the app yet.
 *
 * An inbound webhook URL looks like:
 *   https://<portal>.bitrix24.ru/rest/<user_id>/<code>/
 * The token is embedded in the URL path and DOES NOT expire (unlike OAuth
 * access tokens). REST methods are called as `<base>/<method>.json` with NO
 * `auth` parameter in the body — the URL itself authorizes the call.
 *
 * This module is pure: given a webhook URL it returns a context object the
 * bitrixRestClient understands. No network, no side effects.
 */

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

/**
 * Parse an inbound webhook URL into a context the REST client can consume.
 * Returns null if the URL is empty or not a plausible webhook endpoint.
 *
 * The returned context carries:
 *   - isWebhook: true              → client skips `auth` + OAuth refresh
 *   - endpoint: '<base>/rest/<uid>/<code>'  → REST base (no trailing slash)
 *   - domain: '<portal host>'      → for logging/title resolution
 *   - key: 'webhook'               → marks a non-per-user context
 */
export const buildWebhookContext = (webhookUrl) => {
  const raw = trimTrailingSlash(webhookUrl);
  if (!raw) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  // Expect .../rest/<user_id>/<code>  (code may itself contain no slashes)
  const restMatch = parsed.pathname.match(/\/rest\/(\d+)\/([^/]+)/i);
  if (!restMatch) {
    return null;
  }

  return {
    isWebhook: true,
    key: 'webhook',
    endpoint: raw, // already trailing-slash-trimmed; client appends `/<method>.json`
    domain: parsed.host.toLowerCase(),
    userId: Number(restMatch[1]) || 0
  };
};

/** True when a (already-normalized or raw) context represents a webhook. */
export const isWebhookContext = (context) => Boolean(context && context.isWebhook);

export default buildWebhookContext;
