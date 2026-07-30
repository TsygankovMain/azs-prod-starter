/**
 * sanitizeBundle — валидация и повторная редакция диаг-бандла на сервере.
 *
 * Клиент уже редактирует секреты, но бандл приходит из браузера: он может быть
 * подделан или собран устаревшей сборкой фронта. Приватность держится здесь.
 */
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);
const SECRET_QUERY_KEYS = new Set(['token', 'access_token', 'auth', 'sessid']);
const ALLOWED_TRIGGERS = new Set(['button', 'auto_upload_error']);
const REDACTED = '***';

// Словарь выровнен по utils/maskSecret.js (SENSITIVE_KEYS) и расширен формами,
// которые реально встречаются в текстах ошибок. Порядок важен: длинные варианты
// раньше коротких, иначе `token` съест префикс у `access_token`.
const SECRET_TEXT_KEYS = [
  'access[_-]?token', 'refresh[_-]?token', 'id[_-]?token', 'token',
  'auth[_-]?id', 'authorization', 'auth',
  'session[_-]?id', 'sess[_-]?id', 'sessid',
  'api[_-]?key', 'client[_-]?secret', 'secret',
  'password', 'passwd', 'pwd'
].join('|');
// Запятая и точка с запятой НЕ терминаторы значения: иначе секрет с запятой
// маскируется частично и пригодный огрызок уезжает в базу.
const KV_RE = new RegExp(`\\b(${SECRET_TEXT_KEYS})"?\\s*[=:]\\s*"?([^&\\s"'<>)\\]}]+)`, 'gi');
const BEARER_RE = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{4,})/gi;

/**
 * Чистит секреты в свободном тексте — сообщениях об ошибках и стеках.
 *
 * Текст ошибки почти всегда содержит URL упавшего запроса, а stack дублирует
 * message. Разбирать это как URL нельзя: строка произвольная. Поэтому ищем
 * пары «ключ=значение» и схемы авторизации.
 */
export const redactText = (text) => {
  const raw = String(text ?? '');
  if (!raw) return '';
  return raw
    .replace(KV_RE, (_m, key) => `${key}=${REDACTED}`)
    .replace(BEARER_RE, (_m, scheme) => `${scheme} ${REDACTED}`);
};

export const MAX_BUNDLE_BYTES = 262_144;
export const DIAG_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const redactHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? REDACTED : String(value);
  }
  return out;
};

const redactUrl = (rawUrl) => {
  const raw = String(rawUrl ?? '');
  if (!raw) return '';
  try {
    const url = new URL(raw, 'http://local.invalid');
    let touched = false;
    for (const key of Array.from(url.searchParams.keys())) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, REDACTED);
        touched = true;
      }
    }
    if (!touched) return raw;
    return /^[a-z]+:\/\//i.test(raw) ? url.toString() : `${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
};

export const sanitizeBundle = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'bundle_not_an_object' };
  }
  if (Number(raw.v) !== 1) {
    return { ok: false, error: 'unsupported_bundle_version' };
  }
  if (!ALLOWED_TRIGGERS.has(String(raw.trigger))) {
    return { ok: false, error: 'unknown_trigger' };
  }

  const bundle = {
    ...raw,
    net: Array.isArray(raw.net)
      ? raw.net.map((entry) => ({
        ...entry,
        url: redactUrl(entry?.url),
        headers: redactHeaders(entry?.headers)
      }))
      : [],
    // Свободный текст чистим и здесь: клиент это уже делает, но бандл приходит
    // из браузера и может быть собран устаревшей сборкой фронта либо подделан.
    errors: Array.isArray(raw.errors)
      ? raw.errors.map((entry) => ({
        ...entry,
        message: redactText(entry?.message),
        stack: entry?.stack === undefined ? undefined : redactText(entry.stack)
      }))
      : [],
    uploads: Array.isArray(raw.uploads)
      ? raw.uploads.map((entry) => ({ ...entry, message: redactText(entry?.message) }))
      : [],
    queue: raw.queue && typeof raw.queue === 'object'
      ? {
        ...raw.queue,
        slots: Array.isArray(raw.queue.slots)
          ? raw.queue.slots.map((slot) => ({ ...slot, error: redactText(slot?.error) }))
          : []
      }
      : raw.queue
  };

  const sizeBytes = Buffer.byteLength(JSON.stringify(bundle), 'utf8');
  if (sizeBytes > MAX_BUNDLE_BYTES) {
    return { ok: false, error: 'bundle_too_large' };
  }

  return { ok: true, bundle, sizeBytes };
};

/**
 * Короткий код для разговора с оператором («диагностика A7F3QQ»).
 * Алфавит без 0/O/1/I/L — чтобы код можно было продиктовать по телефону.
 */
export const generateDiagCode = (randomBytes) => {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    const byte = randomBytes[i] ?? 0;
    code += DIAG_CODE_ALPHABET[byte % DIAG_CODE_ALPHABET.length];
  }
  return code;
};
