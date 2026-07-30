/**
 * sanitizeBundle — валидация и повторная редакция диаг-бандла на сервере.
 *
 * Клиент уже редактирует секреты, но бандл приходит из браузера: он может быть
 * подделан или собран устаревшей сборкой фронта. Приватность держится здесь.
 */

/**
 * Безопасное приведение к строке. Бандл приходит из браузера, и обычное
 * JSON-тело с полем toString роняет String(): TypeError вылетал наружу
 * HTML-страницей Express со стеком, минуя и наш контракт, и логи.
 */
const toSafeString = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return String(value);
  } catch {
    return '[unserializable]';
  }
};

const ALLOWED_TRIGGERS = new Set(['button', 'auto_upload_error']);
const REDACTED = '***';

// Словарь выровнен по utils/maskSecret.js (SENSITIVE_KEYS) и расширен формами,
// которые реально встречаются в текстах ошибок. Порядок важен: длинные варианты
// раньше коротких, иначе `token` съест префикс у `access_token`.
const SECRET_TEXT_KEYS = [
  'access[_-]?token', 'refresh[_-]?token', 'refresh[_-]?id', 'id[_-]?token',
  '[a-z]{2,}[_-]token', 'token',
  'auth[_-]?id', 'authorization', 'auth',
  'session[_-]?id', 'sess[_-]?id', 'sessid', 'session', 'cookie',
  'api[_-]?key', 'client[_-]?secret', 'secret',
  'password', 'passwd', 'pwd'
].join('|');

// Один словарь на все три пути редакции: свободный текст, имена
// query-параметров и имена заголовков. Раздельные списки уже разъезжались —
// текстовый вырос до 20 форм, а query остался на 4, и refresh_id утекал.
const SECRET_KEY_RE = new RegExp(`^(x-)?(${SECRET_TEXT_KEYS})$`, 'i');
// set-cookie не подходит под шаблон, но обязателен к сокрытию.
const EXTRA_SECRET_HEADERS = new Set(['set-cookie']);

const isSecretKey = (name) => {
  const normalized = String(name || '').toLowerCase();
  return EXTRA_SECRET_HEADERS.has(normalized) || SECRET_KEY_RE.test(normalized);
};

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
  const raw = toSafeString(text);
  if (!raw) return '';
  // BEARER_RE идёт ПЕРВЫМ. Иначе KV_RE съедает слово `Bearer` как значение
  // ключа `authorization` ("Authorization: Bearer <jwt>" -> "Authorization=***"),
  // после чего сам токен остаётся в тексте, а BEARER_RE уже не находит схему.
  return raw
    .replace(BEARER_RE, (_m, scheme) => `${scheme} ${REDACTED}`)
    .replace(KV_RE, (_m, key) => `${key}=${REDACTED}`);
};

export const MAX_BUNDLE_BYTES = 262_144;
export const DIAG_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const redactHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSecretKey(key) ? REDACTED : toSafeString(value);
  }
  return out;
};

export const redactUrl = (rawUrl) => {
  const raw = toSafeString(rawUrl);
  if (!raw) return '';
  try {
    const url = new URL(raw, 'http://local.invalid');
    let touched = false;
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSecretKey(key)) { url.searchParams.set(key, REDACTED); touched = true; }
    }
    // Секреты живут и во фрагменте: OAuth-редиректы кладут access_token
    // после '#'. URL не разбирает hash как query, поэтому разбираем вручную.
    if (url.hash.length > 1) {
      const hashParams = new URLSearchParams(url.hash.slice(1));
      let hashTouched = false;
      for (const key of Array.from(hashParams.keys())) {
        if (isSecretKey(key)) { hashParams.set(key, REDACTED); hashTouched = true; }
      }
      if (hashTouched) { url.hash = `#${hashParams.toString()}`; touched = true; }
    }
    if (!touched) return raw;
    return /^[a-z]+:\/\//i.test(raw) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return raw;
  }
};

export const sanitizeBundle = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'bundle_not_an_object' };
  }
  // Коерсия объекта с полями valueOf/toString бросает TypeError. Обычное JSON-тело
  // не должно ронять приём — только получать отказ.
  const version = typeof raw.v === 'number' || typeof raw.v === 'string' ? Number(raw.v) : NaN;
  if (version !== 1) {
    return { ok: false, error: 'unsupported_bundle_version' };
  }
  if (typeof raw.trigger !== 'string' || !ALLOWED_TRIGGERS.has(raw.trigger)) {
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
        stack: entry?.stack === undefined ? undefined : redactText(entry.stack),
        // Fix round (ревью, S3): source (event.filename) — URL-образное поле,
        // раньше проходило нередактированным. Симметрия с клиентом
        // (buildBundle.ts) проверяется diagRedactionParity.test.js.
        // Re-review fix: должно вести себя как stack выше — отсутствующий
        // source остаётся undefined, а не превращается редакцией в '' —
        // редактирование не имеет права ДОБАВЛЯТЬ поля, которых не было.
        source: entry?.source === undefined ? undefined : redactUrl(entry.source)
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
      : raw.queue,
    // Fix round (ревью, S3): app.route (route.fullPath) — URL-образное поле,
    // раньше проходило нередактированным. raw.app не валидируется бандлом
    // (в отличие от v/trigger), поэтому здесь та же защитная форма, что и
    // у queue выше: не объект/отсутствует — оставляем как есть.
    app: raw.app && typeof raw.app === 'object' && !Array.isArray(raw.app)
      ? { ...raw.app, route: redactUrl(raw.app.route) }
      : raw.app
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
