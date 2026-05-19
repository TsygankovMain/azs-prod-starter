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
