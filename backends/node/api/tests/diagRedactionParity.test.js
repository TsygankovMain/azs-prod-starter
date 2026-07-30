import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactUrl, redactHeaders } from '../src/diag/sanitizeBundle.js';

// Client versions imported from frontend
const clientRedactUrl = (rawUrl) => {
  const raw = String(rawUrl ?? '');
  if (!raw) return '';
  try {
    const url = new URL(raw, 'http://local.invalid');
    let touched = false;
    for (const key of Array.from(url.searchParams.keys())) {
      if (['token', 'access_token', 'refresh_id', 'session', 'private_token', 'client_secret', 'auth', 'sessid', 'password', 'api-key', 'apikey', 'refresh-token', 'session-id'].some(k => k === key.toLowerCase())) {
        url.searchParams.set(key, '***');
        touched = true;
      }
    }
    if (url.hash.length > 1) {
      const hashParams = new URLSearchParams(url.hash.slice(1));
      let hashTouched = false;
      for (const key of Array.from(hashParams.keys())) {
        if (['token', 'access_token', 'refresh_id', 'session', 'private_token', 'client_secret', 'auth', 'sessid', 'password', 'api-key', 'apikey', 'refresh-token', 'session-id'].some(k => k === key.toLowerCase())) {
          hashParams.set(key, '***');
          hashTouched = true;
        }
      }
      if (hashTouched) { url.hash = `#${hashParams.toString()}`; touched = true; }
    }
    if (!touched) return raw;
    return /^[a-z]+:\/\//i.test(raw) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return raw;
  }
};

const clientRedactHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const isSecret = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'x-refresh-token'].includes(key.toLowerCase());
    out[key] = isSecret ? '***' : String(value);
  }
  return out;
};

const clientRedactText = (text) => {
  const raw = String(text ?? '');
  if (!raw) return '';
  const REDACTED = '***';
  const SECRET_TEXT_KEYS = [
    'access[_-]?token', 'refresh[_-]?token', 'refresh[_-]?id', 'id[_-]?token',
    '[a-z]{2,}[_-]token', 'token',
    'auth[_-]?id', 'authorization', 'auth',
    'session[_-]?id', 'sess[_-]?id', 'sessid', 'session', 'cookie',
    'api[_-]?key', 'client[_-]?secret', 'secret',
    'password', 'passwd', 'pwd'
  ].join('|');
  const KV_RE = new RegExp(`\\b(${SECRET_TEXT_KEYS})"?\\s*[=:]\\s*"?([^&\\s"'<>)\\]}]+)`, 'gi');
  const BEARER_RE = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{4,})/gi;
  return raw
    .replace(BEARER_RE, (_m, scheme) => `${scheme} ${REDACTED}`)
    .replace(KV_RE, (_m, key) => `${key}=${REDACTED}`);
};

const URL_CORPUS = [
  '/x?refresh_id=LEAKME', '/x?session=LEAKME', '/x?private_token=LEAKME',
  '/x?client_secret=LEAKME', '/x?token=LEAKME', '/x?access_token=LEAKME',
  '/x?sessid=LEAKME', '/x?password=LEAKME', '/x?api-key=LEAKME',
  'https://o.test/a?x=1#access_token=LEAKME&token_type=bearer',
  '/cb#refresh_id=LEAKME',
  '/api/reports?azsId=548&reportId=12345',
  ''
];

const HEADER_CORPUS = [
  { Authorization: 'LEAKME' }, { cookie: 'LEAKME' }, { 'set-cookie': 'LEAKME' },
  { 'x-api-key': 'LEAKME' }, { 'x-auth-token': 'LEAKME' }, { 'x-refresh-token': 'LEAKME' },
  { 'X-Ok': 'keep', 'content-type': 'application/json' }
];

test('клиент и сервер чистят URL одинаково', () => {
  for (const input of URL_CORPUS) {
    assert.equal(redactUrl(input), clientRedactUrl(input), `расхождение на ${JSON.stringify(input)}`);
  }
});

test('клиент и сервер чистят заголовки одинаково', () => {
  for (const input of HEADER_CORPUS) {
    assert.deepEqual(redactHeaders(input), clientRedactHeaders(input), `расхождение на ${JSON.stringify(input)}`);
  }
});

test('ни один слой не пропускает секрет в URL или заголовках', () => {
  const leaks = [];
  for (const input of URL_CORPUS) {
    if (!input.includes('LEAKME')) continue;
    for (const [layer, fn] of [['клиент', clientRedactUrl], ['сервер', redactUrl]]) {
      if (fn(input).includes('LEAKME')) leaks.push(`  ${layer} url: ${input} -> ${fn(input)}`);
    }
  }
  for (const input of HEADER_CORPUS) {
    for (const [layer, fn] of [['клиент', clientRedactHeaders], ['сервер', redactHeaders]]) {
      const out = JSON.stringify(fn(input));
      if (out.includes('LEAKME')) leaks.push(`  ${layer} headers: ${JSON.stringify(input)} -> ${out}`);
    }
  }
  assert.equal(leaks.length, 0, `Утечки:\n${leaks.join('\n')}`);
});

test('редакция URL сохраняет диагностически полезные параметры', () => {
  for (const fn of [clientRedactUrl, redactUrl]) {
    const out = fn('/api/reports?azsId=548&reportId=12345&token=SECRETV');
    assert.ok(!out.includes('SECRETV'), out);
    assert.ok(out.includes('azsId=548') && out.includes('reportId=12345'), out);
  }
});

test('redactText согласуется между слоями', () => {
  const cases = [
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc',
    'refresh_id=LEAKME',
    'session=LEAKME',
    'POST /api?token=SECRET failed'
  ];
  for (const input of cases) {
    assert.equal(redactText(input), clientRedactText(input), `redactText разошёлся: ${input}`);
  }
});
