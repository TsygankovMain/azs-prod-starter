import test from 'node:test';
import assert from 'node:assert/strict';
import createBitrixRestClient from '../src/dispatch/bitrixRestClient.js';

const createJsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() {
    return JSON.stringify(payload);
  },
  async json() {
    return payload;
  }
});

test('bitrix client builds REST endpoint from per-user portal domain when env endpoint is empty', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return createJsonResponse({
      result: {
        status: 'L'
      }
    });
  };

  try {
    const client = createBitrixRestClient({
      endpoint: '',
      authId: '',
      logger: { info() {}, error() {} }
    });

    const result = await client.callMethod('app.info', {}, {
      domain: 'b24-example.bitrix24.ru',
      authId: 'runtime-access-token'
    });

    assert.equal(result.status, 'L');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://b24-example.bitrix24.ru/rest/app.info.json');
    assert.equal(JSON.parse(String(calls[0].options.body || '{}')).auth, 'runtime-access-token');
  } finally {
    global.fetch = originalFetch;
  }
});

test('bitrix client refreshes token and retries after expired_token', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).includes('/crm.item.get.json')) {
      if (calls.filter((call) => String(call.url).includes('/crm.item.get.json')).length === 1) {
        return createJsonResponse({
          error: 'expired_token',
          error_description: 'The access token provided has expired.'
        }, 401);
      }
      return createJsonResponse({
        result: {
          item: {
            id: 77,
            title: 'Report'
          }
        }
      });
    }

    if (String(url).includes('/oauth/token/')) {
      return createJsonResponse({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        domain: 'nfr-mainsoft.bitrix24.ru',
        client_endpoint: 'https://nfr-mainsoft.bitrix24.ru/rest/'
      });
    }

    throw new Error(`Unexpected URL in test fetch mock: ${url}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://nfr-mainsoft.bitrix24.ru/rest',
      authId: 'expired-access-token',
      refreshToken: 'refresh-token-1',
      oauthDomain: 'nfr-mainsoft.bitrix24.ru',
      clientId: 'local.test',
      clientSecret: 'secret',
      logger: { info() {} }
    });

    const item = await client.getCrmItem({ entityTypeId: 199, id: 77 });
    assert.equal(item?.id, 77);

    const crmCalls = calls.filter((call) => String(call.url).includes('/crm.item.get.json'));
    const refreshCalls = calls.filter((call) => String(call.url).includes('/oauth/token/'));
    assert.equal(crmCalls.length, 2);
    assert.equal(refreshCalls.length, 1);

    const firstPayload = JSON.parse(String(crmCalls[0].options.body || '{}'));
    const secondPayload = JSON.parse(String(crmCalls[1].options.body || '{}'));
    assert.equal(firstPayload.auth, 'expired-access-token');
    assert.equal(secondPayload.auth, 'new-access-token');
  } finally {
    global.fetch = originalFetch;
  }
});

const ERROR_TYPES = [
  { label: 'invalid_token',        body: { error: 'invalid_token', error_description: 'bad token' } },
  { label: 'NO_AUTH_FOUND',        body: { error: 'NO_AUTH_FOUND', error_description: '' } },
  { label: 'Authorization required', body: { error: 'Authorization required', error_description: '' } },
  { label: 'wrong_client_id',      body: { error: 'wrong_client_id', error_description: '' } },
  { label: 'wrong_token',          body: { error: 'wrong_token', error_description: '' } },
  { label: 'INVALID_CREDENTIALS',  body: { error: 'INVALID_CREDENTIALS', error_description: '' } },
  { label: 'unauthorized',         body: { error: 'unauthorized', error_description: '' } },
];

for (const { label, body } of ERROR_TYPES) {
  test(`bitrix client retries after refreshable error: ${label}`, async () => {
    const originalFetch = global.fetch;
    const calls = [];

    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('/app.info.json')) {
        if (calls.filter((u) => u.includes('/app.info.json')).length === 1) {
          return createJsonResponse(body, 401);
        }
        return createJsonResponse({ result: { status: 'L' } });
      }
      if (String(url).includes('/oauth/token/')) {
        return createJsonResponse({
          access_token: 'fresh-token',
          refresh_token: 'fresh-refresh',
          domain: 'test.bitrix24.ru'
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    try {
      const client = createBitrixRestClient({
        endpoint: 'https://test.bitrix24.ru/rest',
        authId: 'old-token',
        refreshToken: 'old-refresh',
        oauthDomain: 'test.bitrix24.ru',
        clientId: 'local.test',
        clientSecret: 'secret',
        logger: { info() {}, error() {} }
      });

      const result = await client.callMethod('app.info', {});
      assert.ok(result?.status !== undefined || result !== undefined);

      const oauthCalls = calls.filter((u) => u.includes('/oauth/token/'));
      const methodCalls = calls.filter((u) => u.includes('/app.info.json'));
      assert.equal(oauthCalls.length, 1, `oauth refresh should be called once for ${label}`);
      assert.equal(methodCalls.length, 2, `method should be retried once for ${label}`);
    } finally {
      global.fetch = originalFetch;
    }
  });
}

test('bitrix client does NOT retry on invalid_client and logs oauth_client_invalid', async () => {
  const originalFetch = global.fetch;
  const loggedErrors = [];

  global.fetch = async (url) => {
    if (String(url).includes('/app.info.json')) {
      return createJsonResponse({ error: 'expired_token', error_description: 'expired' }, 401);
    }
    if (String(url).includes('/oauth/token/')) {
      return createJsonResponse({ error: 'invalid_client', error_description: 'wrong credentials' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://test.bitrix24.ru/rest',
      authId: 'old-token',
      refreshToken: 'old-refresh',
      oauthDomain: 'test.bitrix24.ru',
      clientId: 'bad-client-id',
      clientSecret: 'bad-secret',
      logger: {
        info() {},
        error(event, meta) { loggedErrors.push({ event, meta }); }
      }
    });

    await assert.rejects(() => client.callMethod('app.info', {}), /Bitrix OAuth refresh failed/);

    const oauthInvalidLog = loggedErrors.find((e) => e.event === 'oauth_client_invalid');
    assert.ok(oauthInvalidLog, 'must log oauth_client_invalid event');
  } finally {
    global.fetch = originalFetch;
  }
});

test('bitrix client throws clear error when refresh token is missing', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;

  global.fetch = async () => {
    callCount += 1;
    return createJsonResponse({
      error: 'expired_token',
      error_description: 'The access token provided has expired.'
    }, 401);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://nfr-mainsoft.bitrix24.ru/rest',
      authId: 'expired-access-token',
      refreshToken: '',
      oauthDomain: 'nfr-mainsoft.bitrix24.ru',
      clientId: 'local.test',
      clientSecret: 'secret',
      logger: { info() {} }
    });

    await assert.rejects(
      () => client.getCrmItem({ entityTypeId: 199, id: 77 }),
      /BITRIX_REST_REFRESH_TOKEN is not configured/
    );
    assert.equal(callCount, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('diskApi.uploadFile returns diskObjectId and crmFileId when Bitrix response includes FILE_ID', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/disk.folder.uploadfile.json')) {
      return createJsonResponse({
        result: {
          ID: '901',
          FILE_ID: '1901'
        }
      });
    }
    throw new Error(`Unexpected URL in test fetch mock: ${url}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://test.bitrix24.ru/rest',
      authId: 'token',
      logger: { info() {}, error() {} }
    });

    const uploaded = await client.diskApi.uploadFile(10, {
      fileName: 'photo.jpg',
      content: Buffer.from('mock')
    });

    assert.deepEqual(uploaded, {
      diskObjectId: 901,
      crmFileId: 1901,
      fileName: 'photo.jpg'
    });
    assert.equal(calls.filter((u) => u.includes('/disk.file.get.json')).length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('diskApi.uploadFile falls back to disk.file.get when FILE_ID is missing', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/disk.folder.uploadfile.json')) {
      return createJsonResponse({
        result: {
          ID: '902'
          // FILE_ID omitted
        }
      });
    }
    if (String(url).includes('/disk.file.get.json')) {
      return createJsonResponse({
        result: {
          FILE_ID: '1902'
        }
      });
    }
    throw new Error(`Unexpected URL in test fetch mock: ${url}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://test.bitrix24.ru/rest',
      authId: 'token',
      logger: { info() {}, error() {} }
    });

    const uploaded = await client.diskApi.uploadFile(10, {
      fileName: 'photo2.jpg',
      content: Buffer.from('mock')
    });

    assert.deepEqual(uploaded, {
      diskObjectId: 902,
      crmFileId: 1902,
      fileName: 'photo2.jpg'
    });
    assert.equal(calls.filter((u) => u.includes('/disk.file.get.json')).length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// listCrmItems — huge-data pagination (BUG-010 / W4-1)
// ---------------------------------------------------------------------------

test('listCrmItems huge-data: two pages, second shorter than 50 → stops; start=-1 on all calls; >id cursor advances', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    calls.push({ url: String(url), body });

    const idCursor = Number(body.filter?.['>id'] ?? 0);

    if (idCursor === 0) {
      // First page: full 50 records, ids 1..50
      const page1 = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
      return createJsonResponse({ result: { items: page1 }, time: {} });
    }
    if (idCursor === 50) {
      // Second page: 23 records (shorter than 50 → signals end)
      const page2 = Array.from({ length: 23 }, (_, i) => ({ id: i + 51 }));
      return createJsonResponse({ result: { items: page2 }, time: {} });
    }
    // Should not be reached
    return createJsonResponse({ result: { items: [] }, time: {} });
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://b24-example.bitrix24.ru/rest',
      authId: 'access-token',
      logger: { info() {}, error() {}, debug() {} }
    });

    const items = await client.listCrmItems({
      entityTypeId: 1234,
      filter: { 'STATUS': 'active' },
      limit: 500,
      context: {
        domain: 'b24-example.bitrix24.ru',
        authId: 'access-token'
      }
    });

    // Results
    assert.equal(items.length, 73);
    assert.equal(items[0].id, 1);
    assert.equal(items[49].id, 50);
    assert.equal(items[50].id, 51);
    assert.equal(items[72].id, 73);

    // Two HTTP calls made
    assert.equal(calls.length, 2);

    // Both calls use start=-1 (huge-data mode)
    assert.equal(calls[0].body.start, -1, 'first call must use start=-1');
    assert.equal(calls[1].body.start, -1, 'second call must use start=-1');

    // First call has no >id filter (caller filter only)
    assert.equal(calls[0].body.filter?.STATUS, 'active', 'caller filter must be preserved');
    assert.equal(calls[0].body.filter?.['>id'], undefined, 'first call must not have >id filter');

    // Second call has >id=50 (max id of first page) + caller filter
    assert.equal(calls[1].body.filter?.['>id'], 50, 'second call must have >id=50 cursor');
    assert.equal(calls[1].body.filter?.STATUS, 'active', 'caller filter must be preserved in second call');

    // Order is ID ASC on both calls
    assert.deepEqual(calls[0].body.order, { id: 'ASC' });
    assert.deepEqual(calls[1].body.order, { id: 'ASC' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('listCrmItems huge-data: empty first page returns [] immediately', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    calls.push(body);
    return createJsonResponse({ result: { items: [] }, time: {} });
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://b24-example.bitrix24.ru/rest',
      authId: 'token',
      logger: { info() {}, error() {}, debug() {} }
    });

    const items = await client.listCrmItems({ entityTypeId: 99 });

    assert.equal(items.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].start, -1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('listCrmItems legacy fallback: custom order → uses start-based pagination, not huge-data', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    calls.push(body);

    if ((body.start ?? 0) === 0) {
      const page1 = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
      return createJsonResponse({ result: { items: page1 }, next: 50, time: {} });
    }
    if (body.start === 50) {
      const page2 = Array.from({ length: 10 }, (_, i) => ({ id: i + 51 }));
      return createJsonResponse({ result: { items: page2 }, time: {} });
    }
    return createJsonResponse({ result: { items: [] }, time: {} });
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://b24-example.bitrix24.ru/rest',
      authId: 'token',
      logger: { info() {}, error() {}, debug() {} }
    });

    const items = await client.listCrmItems({
      entityTypeId: 1234,
      order: { title: 'DESC' }, // non-default order → legacy path
      limit: 500
    });

    assert.equal(items.length, 60);

    // Legacy path: start 0 then 50 (from `next` cursor in response)
    assert.equal(calls.length, 2);
    assert.equal(calls[0].start, 0, 'legacy path first call must use start=0');
    assert.equal(calls[1].start, 50, 'legacy path second call must use start=50 from next');

    // No >id cursor injected
    assert.equal(calls[0].filter?.['>id'], undefined, 'legacy path must not inject >id filter');
    assert.equal(calls[1].filter?.['>id'], undefined, 'legacy path must not inject >id filter on second call');

    // Order preserved as-is
    assert.deepEqual(calls[0].order, { title: 'DESC' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('listCrmItems legacy fallback: caller filter already has >id → uses start-based pagination', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    calls.push(body);
    const items = Array.from({ length: 5 }, (_, i) => ({ id: i + 100 }));
    return createJsonResponse({ result: { items }, time: {} });
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://b24-example.bitrix24.ru/rest',
      authId: 'token',
      logger: { info() {}, error() {}, debug() {} }
    });

    const items = await client.listCrmItems({
      entityTypeId: 1234,
      filter: { '>id': 99 }, // caller already has >id cursor
      limit: 50
    });

    assert.equal(items.length, 5);
    assert.equal(calls.length, 1);
    // Legacy path uses start=0, not start=-1
    assert.equal(calls[0].start, 0, 'legacy path must use start=0 when caller has >id');
    // Caller filter preserved as-is
    assert.equal(calls[0].filter?.['>id'], 99);
  } finally {
    global.fetch = originalFetch;
  }
});

test('bitrix client retries transient HTTP 429 errors with backoff policy', async () => {
  const originalFetch = global.fetch;
  let attempt = 0;

  global.fetch = async (url) => {
    if (String(url).includes('/app.info.json')) {
      attempt += 1;
      if (attempt <= 2) {
        return {
          ok: false,
          status: 429,
          async text() {
            return JSON.stringify({
              error: 'OPERATION_TIME_LIMIT',
              error_description: 'Method is blocked due to operation time limit.'
            });
          }
        };
      }
      return createJsonResponse({ result: { status: 'L' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://test.bitrix24.ru/rest',
      authId: 'token',
      retryBackoffMs: [0, 0, 0],
      logger: { info() {}, error() {} }
    });

    const result = await client.callMethod('app.info', {});
    assert.equal(result.status, 'L');
    assert.equal(attempt, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('bitrix client does not retry non-retryable ACCESS_DENIED errors', async () => {
  const originalFetch = global.fetch;
  let attempt = 0;

  global.fetch = async (url) => {
    if (String(url).includes('/crm.item.update.json')) {
      attempt += 1;
      return createJsonResponse({
        error: 'ACCESS_DENIED',
        error_description: 'Доступ запрещен'
      }, 400);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://test.bitrix24.ru/rest',
      authId: 'token',
      retryBackoffMs: [0, 0, 0],
      logger: { info() {}, error() {} }
    });

    await assert.rejects(
      () => client.callMethod('crm.item.update', { entityTypeId: 1, id: 1, fields: {} }),
      /ACCESS_DENIED/
    );
    assert.equal(attempt, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('webhook context: call goes to webhook URL with NO auth in body', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return createJsonResponse({ result: { status: 'L' } });
  };
  try {
    const client = createBitrixRestClient({ endpoint: '', authId: '', logger: { info() {}, error() {} } });
    const result = await client.callMethod('app.info', {}, {
      isWebhook: true,
      endpoint: 'https://p.bitrix24.ru/rest/498/whcode'
    });
    assert.equal(result.status, 'L');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://p.bitrix24.ru/rest/498/whcode/app.info.json');
    const body = JSON.parse(String(calls[0].options.body || '{}'));
    assert.equal('auth' in body, false, 'webhook calls must not include an auth param');
  } finally {
    global.fetch = originalFetch;
  }
});

test('webhook context: a refreshable-looking error is NOT OAuth-refreshed (no refresh attempt)', async () => {
  const originalFetch = global.fetch;
  let oauthCalls = 0;
  let methodCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/oauth/token/')) { oauthCalls += 1; return createJsonResponse({ access_token: 'x', refresh_token: 'y' }); }
    if (u.includes('/app.info.json')) { methodCalls += 1; return createJsonResponse({ error: 'expired_token', error_description: 'x' }, 401); }
    throw new Error(`unexpected ${u}`);
  };
  try {
    const client = createBitrixRestClient({ endpoint: '', authId: '', clientId: 'c', clientSecret: 's', logger: { info() {}, error() {} } });
    await assert.rejects(() => client.callMethod('app.info', {}, {
      isWebhook: true,
      endpoint: 'https://p.bitrix24.ru/rest/498/whcode'
    }), /expired_token/);
    assert.equal(oauthCalls, 0, 'webhook must never trigger OAuth refresh');
    assert.equal(methodCalls, 1, 'method called once, no retry');
  } finally {
    global.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// S1-03: 503 / Retry-After / AbortError (timeout) tests
// ---------------------------------------------------------------------------

test('bitrix client retries HTTP 503 and succeeds on second attempt', async () => {
  const originalFetch = global.fetch;
  let attempt = 0;

  global.fetch = async (url) => {
    if (String(url).includes('/app.info.json')) {
      attempt += 1;
      if (attempt === 1) {
        return {
          ok: false,
          status: 503,
          headers: { get: () => null },
          async text() { return 'Service Unavailable'; }
        };
      }
      return createJsonResponse({ result: { status: 'L' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://test.bitrix24.ru/rest',
      authId: 'token',
      retryBackoffMs: [0, 0, 0],
      logger: { info() {}, error() {} }
    });

    const result = await client.callMethod('app.info', {});
    assert.equal(result.status, 'L');
    assert.equal(attempt, 2, '503 must trigger a retry');
  } finally {
    global.fetch = originalFetch;
  }
});

test('bitrix client respects Retry-After header on 503 (uses header delay not default backoff)', async () => {
  const originalFetch = global.fetch;
  let attempt = 0;
  const sleepDelays = [];
  // We will inject a spy sleep by temporarily overriding sleep via the constructor
  // and checking the retryAfterMs property on the thrown error.

  // Strategy: inject retryBackoffMs=[99999] so default backoff is huge,
  // but Retry-After:0 should override it to near-zero delay — test completes fast.
  global.fetch = async (url) => {
    if (String(url).includes('/app.info.json')) {
      attempt += 1;
      if (attempt === 1) {
        return {
          ok: false,
          status: 503,
          headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '0' : null },
          async text() { return 'Service Unavailable'; }
        };
      }
      return createJsonResponse({ result: { status: 'L' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://test.bitrix24.ru/rest',
      authId: 'token',
      // Large default backoff — would make test slow if Retry-After is ignored
      retryBackoffMs: [5000, 5000, 5000],
      logger: { info() {}, error() {} }
    });

    const start = Date.now();
    const result = await client.callMethod('app.info', {});
    const elapsed = Date.now() - start;

    assert.equal(result.status, 'L');
    assert.equal(attempt, 2);
    // Retry-After:0 → delay should be close to 0 (under 2000ms), not the 5000ms default backoff
    assert.ok(elapsed < 2000, `Retry-After:0 should result in fast retry, got ${elapsed}ms`);
  } finally {
    global.fetch = originalFetch;
  }
});

test('bitrix client treats AbortError (timeout) as transient and retries', async () => {
  const originalFetch = global.fetch;
  let attempt = 0;

  global.fetch = async (url) => {
    if (String(url).includes('/app.info.json')) {
      attempt += 1;
      if (attempt === 1) {
        // Simulate AbortSignal.timeout() firing
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      return createJsonResponse({ result: { status: 'L' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://test.bitrix24.ru/rest',
      authId: 'token',
      retryBackoffMs: [0, 0, 0],
      logger: { info() {}, error() {} }
    });

    const result = await client.callMethod('app.info', {});
    assert.equal(result.status, 'L');
    assert.equal(attempt, 2, 'TimeoutError must trigger a retry');
  } finally {
    global.fetch = originalFetch;
  }
});

// ── downloadFileContent: 401 → refresh → retry ────────────────────────────────

test('diskApi.downloadFileContent: 401 from file server → refreshes token → retries once → 200', async () => {
  const originalFetch = global.fetch;
  const fileGetCalls = [];
  const downloadCalls = [];
  const oauthCalls = [];
  let fileGetCallCount = 0;

  global.fetch = async (url, options = {}) => {
    const urlStr = String(url);

    if (urlStr.includes('/disk.file.get.json')) {
      fileGetCallCount += 1;
      fileGetCalls.push({ url: urlStr, fileGetCallCount });
      const auth = JSON.parse(options.body || '{}')?.auth;
      const downloadUrl = `https://cdn.bitrix24.ru/download/file_42?auth=${auth}`;
      return createJsonResponse({
        result: {
          ID: '42',
          NAME: 'photo.jpg',
          DOWNLOAD_URL: downloadUrl
        }
      });
    }

    if (urlStr.includes('/download/file_42')) {
      downloadCalls.push(urlStr);
      // First download attempt returns 401 (expired user token)
      if (downloadCalls.length === 1) {
        return { ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      // Second attempt (after refresh) succeeds
      const fakeBytes = Buffer.from('FAKEPNG');
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength)
      };
    }

    if (urlStr.includes('/oauth/token/')) {
      oauthCalls.push(urlStr);
      return createJsonResponse({
        access_token: 'refreshed-token',
        refresh_token: 'new-refresh',
        domain: 'test.bitrix24.ru',
        client_endpoint: 'https://test.bitrix24.ru/rest/'
      });
    }

    throw new Error(`Unexpected URL in downloadFileContent test: ${urlStr}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://test.bitrix24.ru/rest',
      authId: 'expired-user-token',
      refreshToken: 'user-refresh-token',
      oauthDomain: 'test.bitrix24.ru',
      clientId: 'local.test',
      clientSecret: 'secret',
      retryBackoffMs: [0],
      logger: { info() {}, warn() {}, error() {} }
    });

    const result = await client.diskApi.downloadFileContent(42, {});
    assert.ok(typeof result.base64 === 'string' && result.base64.length > 0, 'should return base64 data');
    assert.equal(result.name, 'photo.jpg', 'should return file name');

    assert.equal(oauthCalls.length, 1, 'OAuth refresh must be called exactly once');
    assert.equal(fileGetCalls.length, 2, 'disk.file.get must be called twice (initial + after refresh)');
    assert.equal(downloadCalls.length, 2, 'download must be attempted twice (401 + retry)');
  } finally {
    global.fetch = originalFetch;
  }
});

test('diskApi.downloadFileContent: 401 → refresh throws → propagates error', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/disk.file.get.json')) {
      return createJsonResponse({
        result: { ID: '99', NAME: 'file.jpg', DOWNLOAD_URL: 'https://cdn.bitrix24.ru/dl/99' }
      });
    }
    if (urlStr.includes('/dl/99')) {
      return { ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (urlStr.includes('/oauth/token/')) {
      return createJsonResponse({ error: 'invalid_client', error_description: 'bad credentials' });
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://test.bitrix24.ru/rest',
      authId: 'expired-token',
      refreshToken: 'refresh-token',
      oauthDomain: 'test.bitrix24.ru',
      clientId: 'bad-id',
      clientSecret: 'bad-secret',
      retryBackoffMs: [0],
      logger: { info() {}, warn() {}, error() {} }
    });

    await assert.rejects(
      () => client.diskApi.downloadFileContent(99, {}),
      /Bitrix OAuth refresh failed/,
      'should propagate refresh failure'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('diskApi.downloadFileContent: webhook context — does NOT attempt token refresh on 401', async () => {
  const originalFetch = global.fetch;
  let oauthAttempts = 0;

  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/disk.file.get.json')) {
      return createJsonResponse({
        result: { ID: '77', NAME: 'img.jpg', DOWNLOAD_URL: 'https://cdn.bitrix24.ru/dl/77' }
      });
    }
    if (urlStr.includes('/dl/77')) {
      return { ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (urlStr.includes('/oauth/token/')) {
      oauthAttempts += 1;
      return createJsonResponse({ access_token: 'new', refresh_token: 'new', domain: 'wh.bitrix24.ru' });
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: '',
      authId: '',
      refreshToken: 'refresh',
      clientId: 'local.test',
      clientSecret: 'secret',
      retryBackoffMs: [0],
      logger: { info() {}, warn() {}, error() {} }
    });

    const webhookContext = {
      isWebhook: true,
      endpoint: 'https://wh.bitrix24.ru/rest/1/abcdef'
    };

    await assert.rejects(
      () => client.diskApi.downloadFileContent(77, webhookContext),
      /Disk download failed HTTP 401/,
      'should throw without refresh for webhook context'
    );
    assert.equal(oauthAttempts, 0, 'OAuth refresh must NOT be called for webhook context');
  } finally {
    global.fetch = originalFetch;
  }
});

test('diskApi.getExternalLink returns the bare string link (NOT String.prototype.link)', async () => {
  // Bitrix отдаёт ссылку строкой напрямую в result. Регресс: result?.link на
  // строке === String.prototype.link → в ссылку попадало "function link() {…}".
  const originalFetch = global.fetch;
  global.fetch = async () => createJsonResponse({ result: 'https://b24.example.com/~AbC123xyz' });
  try {
    const client = createBitrixRestClient({ endpoint: '', authId: '', logger: { info() {}, error() {} } });
    const link = await client.diskApi.getExternalLink(123, { domain: 'b24-x.bitrix24.ru', authId: 't' });
    assert.equal(typeof link, 'string');
    assert.equal(link, 'https://b24.example.com/~AbC123xyz');
    assert.ok(!link.includes('native code'), 'не должно быть String.prototype.link');
    assert.ok(!link.startsWith('function'), 'ссылка не должна быть функцией');
  } finally {
    global.fetch = originalFetch;
  }
});

test('diskApi.getExternalLink reads LINK from object response', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => createJsonResponse({ result: { LINK: 'https://b24.example.com/obj-link' } });
  try {
    const client = createBitrixRestClient({ endpoint: '', authId: '', logger: { info() {}, error() {} } });
    const link = await client.diskApi.getExternalLink(123, { domain: 'b24-x.bitrix24.ru', authId: 't' });
    assert.equal(link, 'https://b24.example.com/obj-link');
  } finally {
    global.fetch = originalFetch;
  }
});
