const normalizeEndpoint = (value) => String(value || '').replace(/\/+$/, '');

const parseReportItemId = (result) => {
  if (!result) {
    return null;
  }
  if (result.item?.id) {
    return Number(result.item.id);
  }
  if (result.id) {
    return Number(result.id);
  }
  return null;
};

const parseId = (value) => {
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
};

const parseListItems = (result) => {
  const rows = Array.isArray(result) ? result : (Array.isArray(result?.items) ? result.items : []);
  const next = Number(result?.next ?? result?.Next ?? -1);
  return {
    items: rows,
    next: Number.isFinite(next) && next >= 0 ? next : null
  };
};

const normalizeContext = (context = {}) => {
  const source = context && typeof context === 'object' ? context : {};
  return {
    key: String(source.key || '').trim(),
    memberId: String(source.memberId || source.member_id || '').trim(),
    domain: String(source.domain || '').trim().toLowerCase(),
    userId: Number(source.userId ?? source.user_id ?? 0) || 0,
    authId: String(source.authId || source.auth_id || '').trim(),
    refreshToken: String(source.refreshToken || source.refresh_token || '').trim(),
    appSid: String(source.appSid || source.app_sid || '').trim(),
    // Inbound-webhook contexts authorize via the URL path itself — no `auth`
    // param, no OAuth refresh. `endpoint` is the full webhook base.
    isWebhook: Boolean(source.isWebhook),
    endpoint: String(source.endpoint || '').trim()
  };
};

import { RETRYABLE_TRANSIENT_ERROR_PATTERN } from '../shared/transientErrors.js';

const RETRY_BACKOFF_MS = [800, 1600, 3200];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Configurable HTTP timeout for all Bitrix REST / OAuth fetch calls.
// Set BITRIX_HTTP_TIMEOUT_MS to override the default of 30 seconds.
const HTTP_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.BITRIX_HTTP_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
})();

// Separate, longer timeout for binary file downloads (disk.file downloadFileContent).
// Downloading photo attachments over a slow mobile/carrier network can legitimately
// take much longer than a REST API call — the short REST timeout would false-fire.
// Set BITRIX_HTTP_DOWNLOAD_TIMEOUT_MS to override the default of 120 seconds.
const DOWNLOAD_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.BITRIX_HTTP_DOWNLOAD_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
})();

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

function fetchWithDownloadTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
}

export const createBitrixRestClient = ({
  endpoint = process.env.BITRIX_REST_ENDPOINT || '',
  authId = process.env.BITRIX_REST_AUTH_ID || '',
  refreshToken = process.env.BITRIX_REST_REFRESH_TOKEN || '',
  oauthDomain = process.env.BITRIX_OAUTH_DOMAIN || '',
  oauthEndpoint = process.env.BITRIX_OAUTH_ENDPOINT || '',
  clientId = process.env.CLIENT_ID || '',
  clientSecret = process.env.CLIENT_SECRET || '',
  retryBackoffMs = RETRY_BACKOFF_MS,
  onTokenRefreshed = null,
  logger = console
} = {}) => {
  let defaultEndpoint = normalizeEndpoint(endpoint);
  let defaultAuthId = String(authId || '').trim();
  let defaultRefreshToken = String(refreshToken || '').trim();
  let defaultOauthDomain = String(oauthDomain || '').trim().toLowerCase();
  const refreshInFlight = new Map();

  // Bitrix returns several distinct strings when the access token is no longer
  // accepted. We treat all of them as "refreshable" so the on-demand refresh
  // cycle kicks in instead of bubbling 502 to the caller.
  const REFRESHABLE_AUTH_ERROR_PATTERN = /(expired_token|invalid_token|NO_AUTH_FOUND|Authorization required|wrong_client_id|wrong_token|INVALID_CREDENTIALS|unauthorized)/i;
  const isRefreshableAuthError = (error) => REFRESHABLE_AUTH_ERROR_PATTERN.test(String(error?.message || error || ''));
  const isRetryableTransientError = (error) => RETRYABLE_TRANSIENT_ERROR_PATTERN.test(String(error?.message || error || ''));
  const runtimeRetryBackoffMs = (Array.isArray(retryBackoffMs) ? retryBackoffMs : RETRY_BACKOFF_MS)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);

  // `invalid_client` from the OAuth token endpoint means CLIENT_ID/SECRET is
  // wrong — no point in retrying, surface it loudly so ops can rotate creds.
  const isOauthClientInvalid = (error) => /invalid_client/i.test(String(error?.message || error || ''));

  const resolveRuntimeContext = (context = {}) => {
    const input = normalizeContext(context);

    // Webhook context: the URL path carries auth. Use its endpoint verbatim,
    // never attach OAuth credentials, never fall back to OAuth defaults.
    if (input.isWebhook && input.endpoint) {
      return {
        ...input,
        endpoint: normalizeEndpoint(input.endpoint),
        authId: '',
        refreshToken: '',
        domain: input.domain
      };
    }

    const domain = input.domain || defaultOauthDomain;
    const runtimeEndpoint = normalizeEndpoint(
      context?.endpoint
      || (domain ? `https://${domain}/rest` : '')
      || defaultEndpoint
    );
    return {
      ...input,
      endpoint: runtimeEndpoint,
      authId: input.authId || defaultAuthId,
      refreshToken: input.refreshToken || defaultRefreshToken,
      domain
    };
  };

  const ensureConfigured = (runtime) => {
    if (!runtime.endpoint) {
      throw new Error('Bitrix portal domain or BITRIX_REST_ENDPOINT is required');
    }
  };

  const resolveOauthUrl = (runtime) => {
    const explicit = normalizeEndpoint(oauthEndpoint);
    if (explicit) {
      return explicit;
    }
    if (runtime.domain) {
      return `https://${runtime.domain}/oauth/token/`;
    }
    return 'https://oauth.bitrix.info/oauth/token/';
  };

  const persistRefreshResult = async (runtime, payload) => {
    const nextContext = normalizeContext({
      ...runtime,
      authId: String(payload?.access_token || '').trim() || runtime.authId,
      refreshToken: String(payload?.refresh_token || '').trim() || runtime.refreshToken,
      domain: String(payload?.domain || '').trim().toLowerCase() || runtime.domain
    });
    const clientEndpoint = normalizeEndpoint(payload?.client_endpoint || '');
    if (clientEndpoint) {
      nextContext.endpoint = clientEndpoint;
    } else if (nextContext.domain) {
      nextContext.endpoint = normalizeEndpoint(`https://${nextContext.domain}/rest`);
    }

    if (typeof onTokenRefreshed === 'function') {
      await onTokenRefreshed(nextContext);
    }

    // Update module-level defaults only for the bootstrap (no per-user key)
    // refresh flow. Never mutate process.env — that would race across users.
    if (!runtime.key) {
      if (nextContext.authId) {
        defaultAuthId = nextContext.authId;
      }
      if (nextContext.refreshToken) {
        defaultRefreshToken = nextContext.refreshToken;
      }
      if (nextContext.domain) {
        defaultOauthDomain = nextContext.domain;
      }
      if (nextContext.endpoint) {
        defaultEndpoint = nextContext.endpoint;
      }
    }

    return nextContext;
  };

  const refreshAccessToken = async (runtime) => {
    const refreshKey = runtime.key || `global:${runtime.domain}:${runtime.userId}`;
    if (refreshInFlight.has(refreshKey)) {
      return refreshInFlight.get(refreshKey);
    }

    const promise = (async () => {
      if (!runtime.refreshToken) {
        throw new Error('BITRIX_REST_REFRESH_TOKEN is not configured');
      }
      if (!clientId || !clientSecret) {
        throw new Error('CLIENT_ID and CLIENT_SECRET are required for OAuth token refresh');
      }

      const response = await fetchWithTimeout(resolveOauthUrl(runtime), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: String(clientId),
          client_secret: String(clientSecret),
          refresh_token: runtime.refreshToken
        })
      });

      const rawBody = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(rawBody);
      } catch (_) {
        payload = null;
      }

      if (!response.ok || payload?.error) {
        const reason = payload?.error
          ? `${payload.error}${payload.error_description ? ` ${payload.error_description}` : ''}`
          : `HTTP ${response.status}${rawBody ? `: ${rawBody}` : ''}`;
        throw new Error(`Bitrix OAuth refresh failed: ${reason}`);
      }

      if (!String(payload?.access_token || '').trim()) {
        throw new Error('Bitrix OAuth refresh failed: access_token is missing in response');
      }

      const updated = await persistRefreshResult(runtime, payload);
      logger.info('Bitrix OAuth token refreshed', {
        userId: updated.userId || null,
        domain: updated.domain || null
      });
      return updated;
    })();

    refreshInFlight.set(refreshKey, promise);
    try {
      return await promise;
    } finally {
      refreshInFlight.delete(refreshKey);
    }
  };

  const callInternalOnce = async (method, params = {}, options = {}) => {
    const runtime = resolveRuntimeContext(options.context);
    ensureConfigured(runtime);
    // Webhook endpoints authorize via the URL path — never attach `auth`.
    const resolvedAuth = runtime.isWebhook
      ? ''
      : String(options.authOverride || runtime.authId || '').trim();
    const requestPayload = resolvedAuth
      ? { ...params, auth: resolvedAuth }
      : params;

    const response = await fetchWithTimeout(`${runtime.endpoint}/${method}.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const err = new Error(`Bitrix REST ${method} failed with HTTP ${response.status}${errorBody ? `: ${errorBody}` : ''}`);
      const retryAfterHeader = response.headers?.get('retry-after');
      const retryAfterSeconds = Number(retryAfterHeader);
      if (retryAfterHeader !== null && retryAfterHeader !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
        err.retryAfterMs = retryAfterSeconds * 1000;
      }
      throw err;
    }

    const responsePayload = await response.json();
    if (responsePayload.error) {
      throw new Error(`Bitrix REST ${method} error: ${responsePayload.error} ${responsePayload.error_description || ''}`.trim());
    }

    return responsePayload.result ?? responsePayload;
  };

  const callInternalWithAuthRefresh = async (method, params = {}, options = {}) => {
    try {
      return await callInternalOnce(method, params, options);
    } catch (error) {
      // Webhook contexts have no OAuth refresh_token — never attempt a refresh
      // cycle for them; surface the error directly.
      const runtimeForRefresh = resolveRuntimeContext(options.context);
      const canRefresh = !runtimeForRefresh.isWebhook
        && !options.authOverride
        && isRefreshableAuthError(error);
      if (!canRefresh) {
        throw error;
      }
      const runtime = resolveRuntimeContext(options.context);
      let refreshedContext;
      try {
        refreshedContext = await refreshAccessToken(runtime);
      } catch (refreshError) {
        if (isOauthClientInvalid(refreshError)) {
          logger.error('oauth_client_invalid', {
            method,
            domain: runtime.domain || null,
            userId: runtime.userId || null,
            message: refreshError.message
          });
        }
        throw refreshError;
      }
      return callInternalOnce(method, params, {
        ...options,
        context: refreshedContext
      });
    }
  };

  const callWithTransientRetry = async ({ method, executor }) => {
    for (let retryIndex = 0; ; retryIndex += 1) {
      try {
        return await executor();
      } catch (error) {
        if (!isRetryableTransientError(error) || retryIndex >= runtimeRetryBackoffMs.length) {
          throw error;
        }
        // Respect Retry-After from a 503 response when present; fall back to
        // the configured exponential backoff schedule otherwise.
        const defaultBackoff = runtimeRetryBackoffMs[retryIndex] + Math.floor(Math.random() * 250);
        const waitMs = error.retryAfterMs ?? defaultBackoff;
        if (typeof logger?.info === 'function') {
          logger.info('bitrix_rest_retry', {
            method,
            retry: retryIndex + 1,
            waitMs,
            retryAfter: error.retryAfterMs != null,
            message: String(error?.message || error || '')
          });
        }
        await sleep(waitMs);
      }
    }
  };

  const callInternal = async (method, params = {}, options = {}) => callWithTransientRetry({
    method,
    executor: () => callInternalWithAuthRefresh(method, params, options)
  });

  const call = async (method, params = {}, context = {}) => callInternal(method, params, { context });
  const callWithAuth = async (method, params = {}, authOverride = '', context = {}) => callInternal(method, params, {
    context,
    authOverride
  });

  const callRawOnce = async (method, params = {}, context = {}) => {
    const runtime = resolveRuntimeContext(context);
    ensureConfigured(runtime);
    const resolvedAuth = String(runtime.authId || '').trim();
    const requestPayload = resolvedAuth
      ? { ...params, auth: resolvedAuth }
      : params;

    try {
      const response = await fetchWithTimeout(`${runtime.endpoint}/${method}.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestPayload)
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        const err = new Error(`Bitrix REST ${method} failed with HTTP ${response.status}${errorBody ? `: ${errorBody}` : ''}`);
        const retryAfterHeader = response.headers?.get('retry-after');
        const retryAfterSeconds = Number(retryAfterHeader);
        if (retryAfterHeader !== null && retryAfterHeader !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
          err.retryAfterMs = retryAfterSeconds * 1000;
        }
        throw err;
      }

      const responsePayload = await response.json();
      if (responsePayload.error) {
        throw new Error(`Bitrix REST ${method} error: ${responsePayload.error} ${responsePayload.error_description || ''}`.trim());
      }

      return responsePayload;
    } catch (error) {
      const canRefresh = isRefreshableAuthError(error);
      if (!canRefresh) {
        throw error;
      }
      let refreshedContext;
      try {
        refreshedContext = await refreshAccessToken(runtime);
      } catch (refreshError) {
        if (isOauthClientInvalid(refreshError)) {
          logger.error('oauth_client_invalid', {
            method,
            domain: runtime.domain || null,
            userId: runtime.userId || null,
            message: refreshError.message
          });
        }
        throw refreshError;
      }
      return callRawOnce(method, params, refreshedContext);
    }
  };

  const callRaw = async (method, params = {}, context = {}) => callWithTransientRetry({
    method,
    executor: () => callRawOnce(method, params, context)
  });

  // Bootstrap context is the fallback used ONLY when a per-request `context`
  // is not supplied (e.g. the very first /api/install before a JWT exists).
  // We deliberately do NOT mutate `process.env.*` here — concurrent users
  // and the dispatch scheduler must rely on `req.bitrixContext` so a tick
  // of one user can never overwrite another's auth state mid-flight.
  const setBootstrapContext = ({
    authId: nextAuthId = '',
    refreshToken: nextRefreshToken = '',
    domain: nextDomain = ''
  } = {}) => {
    if (nextAuthId) {
      defaultAuthId = String(nextAuthId).trim();
    }
    if (nextRefreshToken) {
      defaultRefreshToken = String(nextRefreshToken).trim();
    }
    if (nextDomain) {
      defaultOauthDomain = String(nextDomain).trim().toLowerCase();
      defaultEndpoint = normalizeEndpoint(`https://${defaultOauthDomain}/rest`);
    }
    return {
      authId: defaultAuthId,
      refreshToken: defaultRefreshToken,
      domain: defaultOauthDomain
    };
  };

  return {
    isConfigured: Boolean(defaultEndpoint),
    callMethod: call,
    callMethodWithAuth: callWithAuth,
    // Back-compat: same as setBootstrapContext, no longer mutates process.env.
    setAuthId(nextAuthId) {
      defaultAuthId = String(nextAuthId || '').trim();
      return defaultAuthId;
    },
    setAuthContext: setBootstrapContext,
    setBootstrapContext,

    async createReportItem({ entityTypeId, fields, context = {} }) {
      if (!Number(entityTypeId)) {
        throw new Error('report.entityTypeId is required for crm.item.add');
      }

      const result = await call('crm.item.add', {
        entityTypeId: Number(entityTypeId),
        fields
      }, context);
      const reportItemId = parseReportItemId(result);
      if (!reportItemId) {
        throw new Error('crm.item.add response does not include item id');
      }

      return {
        reportItemId,
        raw: result
      };
    },

    async updateReportItem({ entityTypeId, id, fields, context = {} }) {
      if (!Number(entityTypeId)) {
        throw new Error('report.entityTypeId is required for crm.item.update');
      }
      if (!Number(id)) {
        throw new Error('report item id is required for crm.item.update');
      }

      const result = await call('crm.item.update', {
        entityTypeId: Number(entityTypeId),
        id: Number(id),
        fields
      }, context);

      return {
        reportItemId: Number(id),
        raw: result
      };
    },

    async notifyUser({ userId, message, context = {} }) {
      if (!Number(userId)) {
        throw new Error('notifyUser requires userId');
      }

      const result = await call('im.notify.personal.add', {
        USER_ID: Number(userId),
        MESSAGE: String(message || '')
      }, context);

      logger.info('dispatch notify sent', { userId });
      return result;
    },

    async getCrmItem({ entityTypeId, id, context = {} }) {
      if (!Number(entityTypeId) || !Number(id)) {
        return null;
      }

      const result = await call('crm.item.get', {
        entityTypeId: Number(entityTypeId),
        id: Number(id),
        useOriginalUfNames: 'N'
      }, context);

      return result?.item ?? result ?? null;
    },

    async listCrmItems({
      entityTypeId,
      select = ['id'],
      filter = {},
      order = { id: 'ASC' },
      limit = 200,
      useOriginalUfNames = 'N',
      context = {}
    }) {
      if (!Number(entityTypeId)) {
        return [];
      }

      const maxItems = Math.min(Math.max(Number(limit) || 200, 1), 2000);

      // Huge-data mode is incompatible with:
      //   (a) a custom sort order supplied by the caller — sorting other than
      //       ID ASC means the cursor (>id) would skip/duplicate records;
      //   (b) a caller-supplied '>id' filter — we can't safely compose cursors.
      // In those cases we fall back to the classic start-based pagination.
      const orderKeys = Object.keys(order || {});
      const isDefaultOrder =
        orderKeys.length === 1 &&
        (orderKeys[0] === 'id' || orderKeys[0] === 'ID') &&
        String(Object.values(order)[0]).toUpperCase() === 'ASC';
      const callerUsesIdCursor = Object.keys(filter || {}).some(
        (k) => k === '>id' || k === '>ID'
      );

      if (!isDefaultOrder || callerUsesIdCursor) {
        // ── Legacy path (classic start-based pagination) ──────────────────
        if (typeof logger?.debug === 'function') {
          logger.debug('listCrmItems_legacy_fallback', {
            entityTypeId,
            reason: callerUsesIdCursor ? 'caller_filter_has_id_cursor' : 'custom_order'
          });
        }
        const items = [];
        let start = 0;
        while (items.length < maxItems) {
          const response = await callRaw('crm.item.list', {
            entityTypeId: Number(entityTypeId),
            select,
            filter,
            order,
            start,
            useOriginalUfNames
          }, context);
          const resultData = response.result || {};
          const rows = Array.isArray(resultData) ? resultData : (Array.isArray(resultData.items) ? resultData.items : []);
          const next = Number(response.next ?? -1);
          const nextCursor = Number.isFinite(next) && next >= 0 ? next : null;
          for (const row of rows) {
            items.push(row);
            if (items.length >= maxItems) break;
          }
          if (nextCursor === null || rows.length === 0) break;
          start = nextCursor;
        }
        return items;
      }

      // ── Huge-data path (start=-1, ID ASC cursor) ─────────────────────────
      // Guarantee 'id' is present in select so we can read lastId from rows.
      const selectWithId =
        select.includes('id') || select.includes('ID') || select.includes('*')
          ? select
          : [...select, 'id'];

      const items = [];
      let lastId = 0; // no '>id' filter on the first page

      while (items.length < maxItems) {
        const pageFilter = lastId > 0
          ? { ...filter, '>id': lastId }
          : { ...filter };

        const response = await callRaw('crm.item.list', {
          entityTypeId: Number(entityTypeId),
          select: selectWithId,
          filter: pageFilter,
          order: { id: 'ASC' },
          start: -1,
          useOriginalUfNames
        }, context);

        const resultData = response.result || {};
        const rows = Array.isArray(resultData) ? resultData : (Array.isArray(resultData.items) ? resultData.items : []);

        if (rows.length === 0) break;

        for (const row of rows) {
          items.push(row);
          if (items.length >= maxItems) break;
        }

        // Stop when the page is shorter than a full Bitrix page (50 records) —
        // that means there are no more records, matching the huge-data guide.
        // We also stop if the page came back empty (handled above).
        if (rows.length < 50) break;

        // Advance cursor to the max id in this page.
        const pageMaxId = rows.reduce((max, row) => {
          const rowId = Number(row.id ?? row.ID ?? 0);
          return rowId > max ? rowId : max;
        }, 0);
        if (pageMaxId <= 0) break; // safety: no readable id → stop
        lastId = pageMaxId;
      }

      return items;
    },

    diskApi: {
      async findChildFolder(parentId, name, context = {}) {
        const result = await call('disk.folder.getchildren', {
          id: Number(parentId)
        }, context);

        const items = Array.isArray(result) ? result : (Array.isArray(result.items) ? result.items : []);
        const match = items.find((item) => String(item.NAME || item.name || '').trim() === String(name));
        const matchId = parseId(match?.ID ?? match?.id);
        return matchId ? { id: matchId } : null;
      },

      async findChildFile(parentId, name, context = {}) {
        const result = await call('disk.folder.getchildren', {
          id: Number(parentId)
        }, context);

        const items = Array.isArray(result) ? result : (Array.isArray(result.items) ? result.items : []);
        const match = items.find((item) => (
          String(item.NAME || item.name || '').trim() === String(name)
          && String(item.TYPE || item.type || '').trim().toLowerCase() === 'file'
          && Number(item.DELETED_TYPE ?? item.deleted_type ?? 0) === 0
        ));
        const matchId = parseId(match?.ID ?? match?.id);
        return matchId ? { id: matchId } : null;
      },

      async createFolder(parentId, name, context = {}) {
        const result = await call('disk.folder.addsubfolder', {
          id: Number(parentId),
          data: {
            NAME: String(name)
          }
        }, context);
        const folderId = parseId(result?.ID ?? result?.id);
        if (!folderId) {
          throw new Error('disk.folder.addsubfolder response does not include folder id');
        }
        return { id: folderId };
      },

      async uploadFile(folderId, { fileName, content }, context = {}) {
        const base64 = Buffer.isBuffer(content)
          ? content.toString('base64')
          : Buffer.from(content).toString('base64');

        const result = await call('disk.folder.uploadfile', {
          id: Number(folderId),
          data: {
            NAME: String(fileName)
          },
          fileContent: base64
        }, context);

        const diskObjectId = parseId(result?.ID ?? result?.id);
        if (!diskObjectId) {
          throw new Error('disk.folder.uploadfile response does not include disk object id');
        }

        let crmFileId = parseId(result?.FILE_ID ?? result?.fileId ?? result?.file_id);
        if (!crmFileId) {
          // Bitrix occasionally omits FILE_ID in disk.folder.uploadfile response.
          // Fallback: load disk object and extract its FILE_ID.
          const diskObject = await call('disk.file.get', { id: Number(diskObjectId) }, context);
          crmFileId = parseId(diskObject?.FILE_ID ?? diskObject?.fileId ?? diskObject?.file_id);
        }

        if (!crmFileId) {
          throw new Error('disk.folder.uploadfile response does not include crm file id');
        }

        return { diskObjectId, crmFileId, fileName: String(fileName) };
      },

      async downloadFileContent(diskObjectId, context = {}) {
        const id = Number(diskObjectId);
        if (!id) throw new Error('downloadFileContent requires a disk object id');

        // Helper: fetch fresh disk.file.get info (fresh DOWNLOAD_URL + name).
        const fetchInfo = async (ctx) => {
          const runtime = resolveRuntimeContext(ctx);
          const info = await call('disk.file.get', { id }, ctx);
          const url = String(info?.DOWNLOAD_URL || info?.downloadUrl || info?.download_url || '').trim();
          if (!url) throw new Error('disk.file.get response has no DOWNLOAD_URL');
          return { url, name: String(info?.NAME || info?.name || `file_${id}`), runtime };
        };

        let { url, name, runtime } = await fetchInfo(context);

        let resp = await fetchWithDownloadTimeout(url);

        // 401 from the file server: user token may have expired.
        // Refresh once and retry the full fetchInfo+download cycle.
        if (resp.status === 401 && !resolveRuntimeContext(context).isWebhook) {
          let refreshedContext;
          try {
            refreshedContext = await refreshAccessToken(runtime);
          } catch (refreshError) {
            if (isOauthClientInvalid(refreshError)) {
              logger.error('oauth_client_invalid', {
                method: 'disk.file.get',
                domain: runtime.domain || null,
                message: refreshError.message
              });
            }
            throw refreshError;
          }
          const retried = await fetchInfo(refreshedContext);
          resp = await fetchWithDownloadTimeout(retried.url);
          name = retried.name;
        }

        if (!resp.ok) throw new Error(`Disk download failed HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        return { base64: buf.toString('base64'), name };
      },

      async markFileDeleted(fileId, context = {}) {
        if (!Number(fileId)) {
          throw new Error('disk.file.markdeleted requires file id');
        }

        const result = await call('disk.file.markdeleted', {
          id: Number(fileId)
        }, context);

        const deletedId = parseId(result?.ID ?? result?.id);
        if (!deletedId) {
          throw new Error('disk.file.markdeleted response does not include file id');
        }
        return { id: deletedId };
      },

      /**
       * Получить (или сгенерировать) публичную внешнюю ссылку на папку Диска.
       * Метод: disk.folder.getexternallink
       * BUG-A8: вызывать под admin-OAuth контекстом (не вебхук).
       */
      async getExternalLink(folderId, context = {}) {
        if (!Number(folderId)) {
          throw new Error('disk.folder.getexternallink requires folderId');
        }
        const result = await call('disk.folder.getexternallink', {
          id: Number(folderId)
        }, context);
        // Bitrix возвращает строку-ссылку как result напрямую
        const link = String(result?.LINK ?? result?.link ?? result ?? '').trim();
        if (!link) {
          throw new Error('disk.folder.getexternallink response does not include link');
        }
        return link;
      }
    }
  };
};

export default createBitrixRestClient;
