// BUG: отчёт 60186 (07.09.2026, 23 фото уже лежали на Диске) не доехал до
// карточки CRM — задача crm_sync_jobs упала с «Disk download failed HTTP 403»
// при attempts=0, то есть без единого повтора: 403 не входит в
// RETRYABLE_TRANSIENT_ERROR_PATTERN, по которому server.js решает, повторять ли.
//
// 403 от файлового сервера Диска — это протухшая подписанная DOWNLOAD_URL, а не
// отказ в доступе: живи токен не так долго, пришла бы 401. Ссылка выдаётся
// disk.file.get и живёт недолго, а между её выдачей и скачиванием у нас стоит
// лимитер и очередь фотографий — на отчёте в два десятка фото зазор дорастает
// до времени жизни ссылки. Лечится тем же приёмом, что уже написан для 401:
// перезапросить disk.file.get и скачать по свежей ссылке. Refresh токена при
// этом НЕ нужен — обновлять живой токен незачем.
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

test('diskApi.downloadFileContent: 403 от файлового сервера → свежая DOWNLOAD_URL → повтор → 200', async () => {
  const originalFetch = global.fetch;
  const fileGetCalls = [];
  const downloadCalls = [];
  const oauthCalls = [];

  global.fetch = async (url) => {
    const urlStr = String(url);

    if (urlStr.includes('/disk.file.get.json')) {
      fileGetCalls.push(urlStr);
      return createJsonResponse({
        result: {
          ID: '42',
          NAME: 'photo.jpg',
          // Каждый disk.file.get отдаёт НОВУЮ подписанную ссылку — по номеру
          // выдачи и отличаем протухшую от свежей.
          DOWNLOAD_URL: `https://cdn.bitrix24.ru/download/file_42?sig=${fileGetCalls.length}`
        }
      });
    }

    if (urlStr.includes('/download/file_42')) {
      downloadCalls.push(urlStr);
      if (urlStr.includes('sig=1')) {
        return { ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      const fakeBytes = Buffer.from('FAKEPNG');
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength)
      };
    }

    if (urlStr.includes('/oauth/token/')) {
      oauthCalls.push(urlStr);
      return createJsonResponse({ access_token: 'refreshed-token', refresh_token: 'new-refresh' });
    }

    throw new Error(`Unexpected URL in 403 download test: ${urlStr}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://test.bitrix24.ru/rest',
      authId: 'live-user-token',
      refreshToken: 'user-refresh-token',
      oauthDomain: 'test.bitrix24.ru',
      clientId: 'local.test',
      clientSecret: 'secret',
      retryBackoffMs: [0],
      logger: { info() {}, warn() {}, error() {} }
    });

    const result = await client.diskApi.downloadFileContent(42, {});

    assert.ok(typeof result.base64 === 'string' && result.base64.length > 0, 'должен вернуть содержимое файла');
    assert.equal(result.name, 'photo.jpg', 'должен вернуть имя файла из свежего disk.file.get');
    assert.equal(fileGetCalls.length, 2, 'disk.file.get вызывается дважды: исходный + за свежей ссылкой');
    assert.equal(downloadCalls.length, 2, 'скачивание повторяется ровно один раз');
    assert.equal(oauthCalls.length, 0, 'токен жив — refresh при 403 не нужен');
  } finally {
    global.fetch = originalFetch;
  }
});

test('diskApi.downloadFileContent: 403 остаётся и на свежей ссылке → ошибка после ровно одного повтора', async () => {
  const originalFetch = global.fetch;
  const downloadCalls = [];

  global.fetch = async (url) => {
    const urlStr = String(url);

    if (urlStr.includes('/disk.file.get.json')) {
      return createJsonResponse({
        result: { ID: '42', NAME: 'photo.jpg', DOWNLOAD_URL: 'https://cdn.bitrix24.ru/download/file_42' }
      });
    }

    if (urlStr.includes('/download/file_42')) {
      downloadCalls.push(urlStr);
      return { ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) };
    }

    throw new Error(`Unexpected URL in permanent 403 test: ${urlStr}`);
  };

  try {
    const client = createBitrixRestClient({
      endpoint: 'https://test.bitrix24.ru/rest',
      authId: 'live-user-token',
      retryBackoffMs: [0],
      logger: { info() {}, warn() {}, error() {} }
    });

    await assert.rejects(
      () => client.diskApi.downloadFileContent(42, {}),
      /Disk download failed HTTP 403/,
      'настоящий отказ в доступе обязан долететь до вызывающего'
    );
    assert.equal(downloadCalls.length, 2, 'повтор ровно один — бесконечно долбить закрытый файл нельзя');
  } finally {
    global.fetch = originalFetch;
  }
});
