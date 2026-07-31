import { redactText } from './sanitizeBundle.js';

const DISK_TIMEOUT_MS = 5_000;
const DB_TIMEOUT_MS = 2_000;
// authContextStore по умолчанию (AUTH_CONTEXT_STORE=composite в server.js)
// сначала читает БД — тот же незащищённый от зависания путь, что и probeDb.
// Без своего таймаута повисшая БД держит run() целиком, а не только db-пробу.
const OAUTH_TIMEOUT_MS = 2_000;
const MAX_ERROR_CHARS = 300;

// Коды, по которым сразу понятно, что сломалось на нашей стороне интеграции.
const KNOWN_ERROR_CODES = [
  'wrong_client', 'invalid_grant', 'invalid_token', 'expired_token',
  'NO_AUTH_FOUND', 'ACCESS_DENIED', 'insufficient_scope', 'QUERY_LIMIT_EXCEEDED'
];

const extractErrorCode = (message) => {
  const text = String(message || '');
  for (const code of KNOWN_ERROR_CODES) {
    if (new RegExp(`\\b${code}\\b`, 'i').test(text)) return code;
  }
  return null;
};

const cleanError = (error) => {
  const raw = String(error?.message || error || '');
  return redactText(raw).slice(0, MAX_ERROR_CHARS);
};

/**
 * Ограничивает пробу по времени. Зависший Диск не должен задерживать запрос
 * оператора: таймер unref'ится, чтобы не держать процесс живым.
 *
 * Текст самой ошибки таймаута явно называет себя НАШИМ лимитом и содержит
 * сработавшую величину в мс. Раньше это был голый `${label}_timeout` без
 * контекста, и на боевых бандлах (инцидент 2026-07-31: 147 бандлов подряд,
 * errorCode: null, errorMessage: "disk_timeout", ms: 5000) это читалось так,
 * будто Bitrix не отвечает — хотя на самом деле Bitrix вообще не успевал
 * ответить ДО того, как срабатывал наш же таймер. Без явной оговорки
 * «не ответ Bitrix/БД» эта же путаница повторится при следующем инциденте.
 */
const withTimeout = async (factory, ms, label) => {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(factory),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}_timeout after ${ms}ms — our own limit, not a Bitrix/DB response`)),
          ms
        );
        if (typeof timer.unref === 'function') timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Достаёт последний админский auth-контекст независимо от того, какая
 * реализация authContextStore подключена.
 *
 * Публичный интерфейс всех трёх реализаций в src/auth/*
 * (файловой, БД и составной) — это getLastAdminContext(), отдающий уже
 * разобранный { key, context }. Метод getLastAdmin() с сырой формой
 * { key, payload, updated_at } — приватная деталь БД-хранилища внутри
 * databaseAuthContextStore.js и наружу не экспортируется. Пробуем оба имени:
 * иначе срез, подключённый к реальному authContextStore из server.js, всегда
 * возвращал бы hasContext: false, даже когда токен есть и жив.
 */
const readLastAdminRow = async (authContextStore) => {
  if (typeof authContextStore?.getLastAdmin === 'function') {
    return authContextStore.getLastAdmin();
  }
  if (typeof authContextStore?.getLastAdminContext === 'function') {
    const entry = await authContextStore.getLastAdminContext();
    if (!entry) return null;
    return {
      key: entry.key,
      payload: entry.context,
      updated_at: entry.context?.updatedAt || null
    };
  }
  return null;
};

/**
 * Контекст для bitrixClient.callMethod, собранный из сохранённого payload.
 * Поля — ровно те, что читает normalizeContext() в bitrixRestClient.js:
 * domain нужен, чтобы разрешить rest-эндпоинт портала (без него, как и без
 * BITRIX_REST_ENDPOINT/BITRIX_OAUTH_DOMAIN в этом приложении — они не заданы,
 * clientConfigured: false в бандле это подтверждает — клиент бросает
 * "Bitrix portal domain or BITRIX_REST_ENDPOINT is required" ещё до сети);
 * authId авторизует сам запрос; memberId+domain+userId нужны ВМЕСТЕ, потому
 * что onTokenRefreshed в server.js молча пропускает сохранение обновлённого
 * токена, если хоть одно из них пусто — без них случайный рефреш токена
 * прямо во время пробы был бы потерян.
 */
const buildDiskContext = (payload) => ({
  memberId: payload.memberId || payload.member_id || '',
  domain: payload.domain || '',
  userId: Number(payload.userId ?? payload.user_id ?? 0) || 0,
  authId: payload.authId || payload.auth_id || '',
  refreshToken: payload.refreshToken || payload.refresh_token || ''
});

/**
 * serverSelfCheck — серверная половина диагностической картины.
 *
 * Клиент не видит состояние нашего OAuth-токена и ответ Диска Битрикса, а без
 * них нельзя отличить «сломался наш код» от «сломалась интеграция». Живая проба
 * Диска при сломанном токене вернёт wrong_client — это и есть искомый сигнал.
 *
 * Контракт: run() никогда не бросает, каждая проба ограничена по времени,
 * значения токенов в результат не попадают — только факт наличия и длина.
 */
export const createServerSelfCheck = ({
  authContextStore,
  bitrixClient,
  // Проба Диска звонит через ОТДЕЛЬНЫЙ клиент, не через bitrixClient выше.
  // Причина (боевой инцидент 2026-07-31: ~4200 упавших загрузок за два часа
  // на 15 АЗС): у bitrixClient (см. server.js) включены ретраи транзиентных
  // ошибок — RETRY_BACKOFF_MS = [800, 1600, 3200] в bitrixRestClient.js, это
  // 5600 мс сна ещё ДО самих сетевых попыток. diskTimeoutMs по умолчанию —
  // 5000 мс, поэтому проба физически не могла пережить цикл ретраев:
  // withTimeout обрывал её раньше, чем клиент успевал вернуть настоящую
  // ошибку Bitrix. Логи сервера показывали wrong_client 143 раза за пять
  // минут открытым текстом, а срез вместо этого писал errorCode: null,
  // errorMessage: "disk_timeout" на 147 бандлах подряд — главный сигнал,
  // ради которого этот срез существует, глушился нашей же машинерией
  // ретраев.
  //
  // Проба — измерение, а не боевая работа: ей нужен первый быстрый честный
  // ответ, а не устойчивость к сбоям. diskClient создаётся в server.js через
  // createBitrixRestClient({ retryBackoffMs: [] }) и БЕЗ onTokenRefreshed —
  // проба лишь наблюдает и не имеет права писать обновлённый токен обратно
  // в authContextStore. Один авторефреш при refreshable auth-ошибке (внутри
  // callInternalWithAuthRefresh в bitrixRestClient.js) при этом остаётся —
  // это и есть путь, которым настоящий wrong_client доходит до пробы, и он
  // нам нужен: одна попытка, быстро, реальная ошибка.
  //
  // diskClient не передан (старые тесты/вызовы) → используем bitrixClient,
  // как было раньше — обратная совместимость.
  diskClient = bitrixClient,
  pool,
  logger = console,
  now = () => Date.now(),
  diskTimeoutMs = DISK_TIMEOUT_MS,
  dbTimeoutMs = DB_TIMEOUT_MS,
  oauthTimeoutMs = OAUTH_TIMEOUT_MS
}) => {
  /**
   * Читает и разбирает сохранённый auth-контекст РОВНО ОДИН РАЗ за run() —
   * и probeOauth (форматирует для бандла), и probeDisk (строит из него
   * реальный контекст для звонка в Bitrix) читают один и тот же результат.
   *
   * До этого фикса probeOauth читал стор приватно, а probeDisk и вовсе не
   * читал — звонил с пустым {} контекстом, из-за чего bitrixClient не мог
   * разрешить домен портала и падал на "Bitrix portal domain or
   * BITRIX_REST_ENDPOINT is required" ещё до сетевого вызова: 1мс, errorCode
   * null. Проба была слепой к главному сигналу, ради которого существует —
   * реальному состоянию OAuth. Обнаружено первым же боевым бандлом (АЗС 174,
   * 2026-07-30): oauth уже показывал живой токен (ageSec: 7), а disk молчал
   * о самом Bitrix, потому что запрос из-за пустого контекста не уходил.
   *
   * Таймаут, шим getLastAdmin/getLastAdminContext и терпимость к битому JSON
   * — как и раньше. Никогда не бросает: любой сбой (таймаут, исключение
   * стора, битый или не-объектный JSON) превращается в null.
   */
  const loadAuthContext = async () => {
    try {
      const row = await withTimeout(() => readLastAdminRow(authContextStore), oauthTimeoutMs, 'oauth');
      if (!row) return null;

      let payload = {};
      try {
        const parsed = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        // JSON.parse('null') / JSON.parse('42') — валидный JSON, но не объект.
        // Без этой проверки payload.authId ниже бросил бы на null/примитиве,
        // а probeOauth/probeDisk больше не обёрнуты в свой try/catch —
        // безопасность объекта payload гарантируется здесь, один раз.
        payload = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
      } catch {
        payload = {};
      }

      return { row, payload };
    } catch (error) {
      logger.warn('diag_selfcheck_oauth_failed', { message: cleanError(error) });
      return null;
    }
  };

  // Чистый форматтер: никакого I/O, только преобразование уже прочитанного
  // authContext в форму для бандла — факт и длина, не значения токенов.
  const probeOauth = (authContext) => {
    const empty = {
      hasContext: false, domain: null, memberId: null, updatedAt: null, ageSec: null,
      hasAuthId: false, hasRefreshToken: false, authIdLength: 0, refreshTokenLength: 0,
      clientConfigured: Boolean(bitrixClient?.isConfigured)
    };
    if (!authContext) return empty;

    const { row, payload } = authContext;
    const updatedAt = row.updated_at ? new Date(row.updated_at) : null;
    const ageSec = updatedAt && !Number.isNaN(updatedAt.getTime())
      ? Math.round((now() - updatedAt.getTime()) / 1000)
      : null;

    const authId = String(payload.authId || payload.auth_id || '');
    const refreshToken = String(payload.refreshToken || payload.refresh_token || '');

    return {
      hasContext: true,
      domain: payload.domain ? String(payload.domain) : null,
      memberId: payload.memberId || payload.member_id ? String(payload.memberId || payload.member_id) : null,
      updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt.toISOString() : null,
      ageSec,
      // Только факт и длина: сами значения — секреты.
      hasAuthId: authId.length > 0,
      hasRefreshToken: refreshToken.length > 0,
      authIdLength: authId.length,
      refreshTokenLength: refreshToken.length,
      clientConfigured: Boolean(bitrixClient?.isConfigured)
    };
  };

  const probeDisk = async (authContext) => {
    const startedAt = now();
    try {
      if (!diskClient?.callMethod) {
        return { ok: false, ms: 0, errorCode: null, errorMessage: 'bitrix_client_unavailable' };
      }
      if (!authContext) {
        // Нечем пробовать. Это не «Bitrix отверг нас» (wrong_client и т.п.),
        // а «у нас вообще нет сохранённого контекста» — честный отдельный
        // код, а не тот же "domain ... is required", что и при пустом {}.
        return { ok: false, ms: 0, errorCode: null, errorMessage: 'no_auth_context' };
      }
      const context = buildDiskContext(authContext.payload);
      await withTimeout(() => diskClient.callMethod('disk.storage.getlist', {}, context), diskTimeoutMs, 'disk');
      return { ok: true, ms: now() - startedAt, errorCode: null, errorMessage: null };
    } catch (error) {
      const errorMessage = cleanError(error);
      return { ok: false, ms: now() - startedAt, errorCode: extractErrorCode(errorMessage), errorMessage };
    }
  };

  const probeDb = async () => {
    const startedAt = now();
    try {
      if (!pool?.query) return { ok: false, ms: 0, errorMessage: 'pool_unavailable' };
      await withTimeout(() => pool.query('SELECT 1'), dbTimeoutMs, 'db');
      return { ok: true, ms: now() - startedAt, errorMessage: null };
    } catch (error) {
      return { ok: false, ms: now() - startedAt, errorMessage: cleanError(error) };
    }
  };

  return {
    async run() {
      // Контекст читаем один раз и делимся им между пробами — см.
      // loadAuthContext выше за то, почему это важно.
      const authContext = await loadAuthContext();
      const [disk, db] = await Promise.all([probeDisk(authContext), probeDb()]);
      const oauth = probeOauth(authContext);
      return {
        checkedAt: new Date(now()).toISOString(),
        app: {
          botMode: String(process.env.BITRIX_BOT_MODE || ''),
          nodeEnv: String(process.env.NODE_ENV || ''),
          schedulerEnabled: String(process.env.SCHEDULER_ENABLED || 'true') !== 'false'
        },
        oauth,
        disk,
        db
      };
    }
  };
};

export default createServerSelfCheck;
