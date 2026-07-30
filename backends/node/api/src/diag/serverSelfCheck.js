import { redactText } from './sanitizeBundle.js';

const DISK_TIMEOUT_MS = 5_000;
const DB_TIMEOUT_MS = 2_000;
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
 */
const withTimeout = async (factory, ms, label) => {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(factory),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
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
  pool,
  logger = console,
  now = () => Date.now(),
  diskTimeoutMs = DISK_TIMEOUT_MS,
  dbTimeoutMs = DB_TIMEOUT_MS
}) => {
  const probeOauth = async () => {
    const empty = {
      hasContext: false, domain: null, memberId: null, updatedAt: null, ageSec: null,
      hasAuthId: false, hasRefreshToken: false, authIdLength: 0, refreshTokenLength: 0,
      clientConfigured: Boolean(bitrixClient?.isConfigured)
    };
    try {
      const row = await readLastAdminRow(authContextStore);
      if (!row) return empty;

      let payload = {};
      try {
        payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
      } catch {
        payload = {};
      }

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
    } catch (error) {
      logger.warn('diag_selfcheck_oauth_failed', { message: cleanError(error) });
      return empty;
    }
  };

  const probeDisk = async () => {
    const startedAt = now();
    try {
      if (!bitrixClient?.callMethod) {
        return { ok: false, ms: 0, errorCode: null, errorMessage: 'bitrix_client_unavailable' };
      }
      await withTimeout(() => bitrixClient.callMethod('disk.storage.getlist', {}, {}), diskTimeoutMs, 'disk');
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
      const [oauth, disk, db] = await Promise.all([probeOauth(), probeDisk(), probeDb()]);
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
