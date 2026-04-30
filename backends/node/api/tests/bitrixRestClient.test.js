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
