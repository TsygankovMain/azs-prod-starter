// redeploy marker: 2026-06-04 (dispatch-resilience) — no functional change
import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import { createVerifyToken, createVerifyTokenSignatureOnly } from './utils/verifyToken.js';
import createSettingsRouter from './src/settings/settingsRoutes.js';
import createDatabaseSettingsStore from './src/settings/databaseSettingsStore.js';
import createBitrixAppSettingsStore from './src/settings/bitrixAppSettingsStore.js';
import createCompositeSettingsStore from './src/settings/compositeSettingsStore.js';
import createDispatchLogStore from './src/dispatch/dispatchLogStore.js';
import createBitrixRestClient from './src/dispatch/bitrixRestClient.js';
import createDispatchService from './src/dispatch/dispatchService.js';
import createDispatchRouter from './src/dispatch/dispatchRoutes.js';
import createDispatchScheduler from './src/dispatch/dispatchScheduler.js';
import createTimeoutWatcher from './src/dispatch/timeoutWatcher.js';
import { readDispatchCandidates } from './src/dispatch/dispatchCandidatesFileStore.js';
import createReportsStore from './src/reports/reportsStore.js';
import { createAnalyticsStore } from './src/reports/analyticsStore.js';
import createReportsRouter, { buildCrmSyncRunner, readRequiredPhotos } from './src/reports/reportsRoutes.js';
import createDispatchPlanStore from './src/reports/dispatchPlanStore.js';
import { generateDailyPlan } from './src/dispatch/dispatchPlanGenerator.js';
import createDispatchPlanMirror from './src/reports/dispatchPlanMirror.js';
import { buildWebhookContext } from './src/auth/webhookContext.js';
import createCrmSyncJobStore from './src/reports/crmSyncJobStore.js';
import { createCrmSyncWorker } from './src/reports/crmSyncWorker.js';
import { createPhotoQueueStore } from './src/reports/photoQueueStore.js';
import { createPhotoPublisher } from './src/reports/photoPublisher.js';
import { createPhotoPublishWorker } from './src/reports/photoPublishWorker.js';
import { createPhotoPublishWatchdog } from './src/reports/photoPublishWatchdog.js';
import { syncReportToCrmIfComplete } from './src/reports/photoPublishCompletion.js';
import { createRateLimiter } from './src/shared/rateLimiter.js';
import {
  isEmbeddedPostgresEnabled,
  readPhotoPublishNumberEnv,
  buildPhotoQueueRuntime,
  isPhotoPublishWorkerSupported
} from './src/reports/photoPublishBoot.js';
import { ensureAppPlacements } from './src/bitrix/placementBinder.js';
import createNotificationService from './src/notifications/notificationService.js';
import createBotRegistryService from './src/notifications/botRegistryService.js';
import { createAuthContextStore } from './src/auth/authContextStore.js';
import { createDatabaseAuthContextStore } from './src/auth/databaseAuthContextStore.js';
import { createCompositeAuthContextStore } from './src/auth/compositeAuthContextStore.js';
import { createTokenRefreshScheduler } from './src/auth/tokenRefreshScheduler.js';
import { resolveAccessContext } from './src/access/roleResolver.js';
import createReasonStore from './src/reports/reasonStore.js';
import { createPhotoFeedRouter } from './src/reports/photoFeedRoutes.js';
import createPhotoRemarkStore from './src/reports/photoRemarkStore.js';
import { createPhotoRemarkService } from './src/notifications/photoRemarkService.js';
import { createPhotoRemarkRouter } from './src/reports/photoRemarkRoutes.js';
import createReasonForwardingService from './src/notifications/reasonForwardingService.js';
import { createBotCommandHandler, isReasonButtonPress } from './src/notifications/botCommandHandler.js';
import { createReasonCaptureStore } from './src/notifications/reasonCaptureStore.js';
import { resolveIsAdmin } from './src/auth/resolveIsAdmin.js';
import { resolveInstallAdmin } from './src/auth/resolveInstallAdmin.js';
import { checkBotEventSecret } from './src/security/botEventGate.js';
import { validateRequiredEnv } from './utils/validateEnv.js';
import { resolvePgSslConfig } from './utils/dbSsl.js';
import { RETRYABLE_TRANSIENT_ERROR_PATTERN } from './src/shared/transientErrors.js';
import { maskAuthFields } from './utils/maskSecret.js';
import { resolveBotSettingsContext } from './src/notifications/botSettingsContext.js';
import createBrandRouter from './src/brands/brandRoutes.js';
import { createDatabaseBrandStore } from './src/brands/databaseBrandStore.js';
import { createUsersRouter } from './src/users/usersRoutes.js';
import cron from 'node-cron';
import createDiagRouter from './src/diag/diagRoutes.js';
import { createDiagStore } from './src/diag/diagStore.js';
import { createServerSelfCheck } from './src/diag/serverSelfCheck.js';
import { createDiagChatNotifier } from './src/diag/diagChatNotifier.js';
import {
  createJsonParserBypass,
  createDiagUnavailableHandler,
  createDiagErrorHandler,
  DIAG_SIGNATURE_ONLY_PATHS
} from './src/diag/diagMiddleware.js';

try {
  validateRequiredEnv();
} catch (error) {
  console.error('[fatal]', error.message);
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[process] uncaughtException:', error);
});

const app = express();
app.use(cors());
// Диаг-эндпоинты приносят свои парсеры: бандл до 512 КБ и echo-проба до 1 МБ
// не проходят под дефолтный 100-килобайтный лимит express.json(). Для всех
// остальных маршрутов поведение не меняется.
// Fix round (ревью, S2): сама мидлварь теперь живёт в src/diag/diagMiddleware.js —
// tests/diagParserBypass.test.js импортирует ровно эту функцию, а не свою копию.
app.use(createJsonParserBypass());
// Bitrix24 bot webhook events arrive as application/x-www-form-urlencoded with
// PHP-nested keys (data[message][text]=...). extended:true (qs) parses them into
// nested objects so /api/bot/event can read data.message.text etc.
app.use(express.urlencoded({ extended: true }));

const dbType = (process.env.DB_TYPE || 'postgresql').toLowerCase();
const defaultDbPort = dbType === 'mysql' ? 3306 : 5432;

const pool = dbType === 'mysql'
  ? mysql.createPool({
    host: process.env.DB_HOST || 'database',
    port: Number(process.env.DB_PORT || defaultDbPort),
    database: process.env.DB_NAME || 'appdb',
    user: process.env.DB_USER || 'appuser',
    password: process.env.DB_PASSWORD || 'apppass',
    waitForConnections: true,
    connectionLimit: 10
  })
  : new Pool({
    host: process.env.DB_HOST || 'database',
    port: Number(process.env.DB_PORT || defaultDbPort),
    database: process.env.DB_NAME || 'appdb',
    user: process.env.DB_USER || 'appuser',
    password: process.env.DB_PASSWORD || 'apppass',
    // Waiting for a free connection must not be infinite: if the pool is
    // saturated a new request fails after 3 s with an error (→ 500) instead
    // of blocking forever and piling up in memory.
    connectionTimeoutMillis: 3000,
    // TLS: resolved from DB_SSL / DB_SSL_CA_CONTENT / DB_SSL_CA env vars.
    // undefined = no TLS (dev default); see utils/dbSsl.js for details.
    ...(resolvePgSslConfig(process.env) !== undefined
      ? { ssl: resolvePgSslConfig(process.env) }
      : {})
  });

// pg Pool emits 'error' for idle connection drops — without a listener it becomes
// an uncaughtException and kills the process. mysql2 pools do NOT emit pool-level
// 'error' (per-query errors surface on the query promise), so for mysql this listener
// is a harmless no-op.
const onPoolError = (error) => {
  console.error('[db] idle connection error (recovered):', error.message);
};
if (typeof pool.on === 'function') {
  pool.on('error', onPoolError);
}

const parseUserId = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const pickFirstDefined = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const resolveAppHandlerUrl = () => {
  const base = trimTrailingSlash(process.env.APP_BASE_URL || process.env.VIRTUAL_HOST || '');
  return base ? `${base}/` : '';
};

const buildInstallContext = ({ authId, refreshToken, domain, memberId, userId, appSid }) => ({
  authId,
  refreshToken,
  domain,
  memberId,
  userId,
  appSid
});

const dispatchLogStore = createDispatchLogStore({ pool, dbType });
const reportsStore = createReportsStore({ pool, dbType });
const analyticsStore = createAnalyticsStore({ pool, dbType });
const crmSyncJobStore = createCrmSyncJobStore({ pool, dbType });
const dispatchPlanStore = createDispatchPlanStore({ pool, dbType });
const dbSettingsStore = createDatabaseSettingsStore({ pool, dbType });
const reasonStore = createReasonStore({ pool, dbType });
const photoRemarkStore = createPhotoRemarkStore({ pool, dbType });
const brandStore = createDatabaseBrandStore({ pool, dbType });
// Диагностика — вспомогательная функция и не имеет права мешать приложению
// стартовать. diagStore поддерживает только PostgreSQL; на любой другой СУБД
// диагностика отключается, а приложение поднимается как обычно.
let diagStore = null;
try {
  diagStore = createDiagStore({ pool, dbType });
} catch (error) {
  console.error(JSON.stringify({
    event: 'diag_disabled',
    reason: error.message,
    dbType
  }));
}

// Очередь публикации фото (Task 11 — проводка) — защита загрузки, пункты 5 и
// 6 ревью. buildPhotoQueueRuntime (src/reports/photoPublishBoot.js) — единая
// точка решения:
//   - EMBEDDED_POSTGRES в истинном значении (строго 'true', см.
//     isEmbeddedPostgresEnabled — строка 'false' truthy в JS, наивная
//     проверка включила бы предохранитель ровно наоборот) -> очередь не
//     включается ВООБЩЕ: на встроенной в контейнер, эфемерной БД редеплой
//     стёр бы принятые, но не опубликованные фото — очередь, задуманная как
//     защита от потери, сама стала бы механизмом потери, и молча;
//   - создание стора бросило (например, недоступен pool) -> то же самое
//     правило, что и у diagStore выше: приложение обязано подняться целиком.
// В обоих случаях photoQueueStore ВСЕГДА truthy-объект с работающим (пусть и
// намеренно бросающим понятную ошибку) .accept() — createReportsRouter ниже
// требует его как обязательный параметр конструктора (пункт 7), и заглушка
// не даёт этому требованию погасить ВЕСЬ /api/reports ради проблемы, которая
// касается только фото.
const photoQueueRuntime = buildPhotoQueueRuntime({
  isEmbeddedPostgres: isEmbeddedPostgresEnabled(process.env.EMBEDDED_POSTGRES),
  createStore: () => createPhotoQueueStore({ pool, dbType })
});
const photoQueueStore = photoQueueRuntime.store;
const authContextStoreType = String(process.env.AUTH_CONTEXT_STORE || 'composite').trim().toLowerCase();
const authContextStore = (() => {
  if (authContextStoreType === 'database') {
    return createDatabaseAuthContextStore({ pool, dbType });
  }
  if (authContextStoreType === 'file') {
    return createAuthContextStore();
  }
  // Default: composite — DB primary, file fallback, startup seed
  return createCompositeAuthContextStore({
    dbStore: createDatabaseAuthContextStore({ pool, dbType }),
    fileStore: createAuthContextStore()
  });
})();
const bitrixClient = createBitrixRestClient({
  onTokenRefreshed: async (context) => {
    if (!context?.memberId || !context?.domain || !context?.userId) {
      return;
    }
    // Merge new tokens OVER existing context — never overwrite isAdmin /
    // verifiedAt / appSid that were set during /api/install or /api/getToken.
    // Without this merge a single auto-refresh would silently downgrade the
    // portal admin and break the scheduler / settings save flow.
    const previous = await authContextStore.getContext({
      memberId: context.memberId,
      domain: context.domain,
      userId: context.userId
    }) || {};
    await authContextStore.upsertContext({
      ...previous,
      ...context,
      isAdmin: Boolean(previous.isAdmin) || Boolean(context.isAdmin),
      verifiedAt: previous.verifiedAt || context.verifiedAt || '',
      appSid: previous.appSid || context.appSid || '',
      // Refresh just happened — record the new issuance time so the
      // pre-refresh scheduler can track 30-day TTL accurately.
      refreshTokenIssuedAt: new Date().toISOString()
    });
  }
});
const reasonForwardingService = createReasonForwardingService({ bitrixClient });
const reasonCaptureStore = createReasonCaptureStore();
// After a reason is captured via the bot, mirror the app path (POST /:id/reason):
// write the reason to the CRM report card AND forward it to the responsible chat,
// so the reviewer/manager actually learns WHY the AZS can't submit. Best-effort —
// runs under the server-side background context (webhook-first, else admin OAuth),
// since the operator's app token is not available in a chat. Forward-references
// settingsStore/webhookBackgroundContext (defined below) — only invoked at runtime.
const backgroundContextForBot = async () => (
  webhookBackgroundContext ? webhookBackgroundContext : await getAdminContext()
);
// Reason catalog for the bot's quick-reply buttons (from settings).
// BUG-A8: читаем настройки под adminContext (OAuth-приложение), т.к. app.option.get
// требует контекст приложения — webhook получает 403 ACCESS_DENIED.
const getBotReasons = async () => {
  try {
    const context = resolveBotSettingsContext({
      adminContext: await getAdminContext(),
      webhookContext: webhookBackgroundContext
    });
    const settings = await settingsStore.read({ context });
    return Array.isArray(settings.report?.reasons) ? settings.report.reasons : [];
  } catch {
    return [];
  }
};
const onBotReasonCaptured = async ({ reportId, reasonCode = 'other', reasonText }) => {
  const report = await reportsStore.getById(Number(reportId));
  if (!report) {
    console.warn('bot_reason_report_not_found', { reportId });
    return;
  }
  const context = await backgroundContextForBot();
  // BUG-A8: читаем настройки под adminContext (OAuth) — app.option.get требует контекст
  // приложения; вебхук возвращает 403. CRM-апдейт и forward остаются под context (webhook).
  const adminContext = await getAdminContext();
  const settingsContext = resolveBotSettingsContext({
    adminContext,
    webhookContext: webhookBackgroundContext
  });
  const settings = await settingsStore.read({ context: settingsContext });
  const { createReasonCatalog } = await import('./src/reports/reasonCatalog.js');
  const catalog = createReasonCatalog(Array.isArray(settings.report?.reasons) ? settings.report.reasons : []);
  const code = catalog.isValidCode(reasonCode) ? reasonCode : 'other';
  const reasonValue = catalog.encodeValue(code, reasonText);
  const alreadyDone = String(report.status) === 'done';
  // «Браковать» = стадия «Брак» из настроек (report.stages.rejected). Если она не
  // задана — фоллбек на «просрочено» (expired), чтобы карточка всё равно ушла из
  // работы. Локальный статус зеркалим в expired (в дашборде — «Не сдан»).
  const brakStatus = String(settings?.report?.stages?.rejected || '').trim() ? 'rejected' : 'expired';
  const entityTypeId = Number(settings?.report?.entityTypeId || 0);

  // 1) CRM: «браковать» карточку + записать причину одним обновлением, и зеркалить
  //    статус локально. Стадия меняется даже если UF-поле причины не настроено.
  try {
    const { buildReportCrmUpdateFields } = await import('./src/reports/reportCrmSync.js');
    const fields = buildReportCrmUpdateFields({
      settings,
      status: alreadyDone ? report.status : brakStatus,
      reasonValue
    });
    if (entityTypeId && Number(report.reportItemId) && Object.keys(fields).length) {
      await bitrixClient.updateReportItem({ entityTypeId, id: Number(report.reportItemId), fields, context });
    } else {
      console.warn('bot_reason_crm_skipped', { reportId, entityTypeId, reportItemId: report.reportItemId, fieldCount: Object.keys(fields).length });
    }
    if (!alreadyDone) {
      await reportsStore.setReportStatus({ reportId: Number(reportId), status: 'expired' });
    }
  } catch (crmError) {
    console.warn('bot_reason_crm_update_failed', { reportId, message: crmError.message, code: crmError.code, status: crmError.statusCode });
  }

  // 2) Forward to the responsible chat (best-effort)
  try {
    const { createAzsTitleResolver } = await import('./src/reports/reportsRoutes.js');
    const resolveAzsTitle = createAzsTitleResolver({ bitrixClient, settings, context });
    const azsTitle = await resolveAzsTitle(report.azsId).catch(() => String(report.azsId || ''));
    await reasonForwardingService.forward({
      settings,
      azsTitle,
      operatorName: 'Сотрудник АЗС',
      reasonLabel: catalog.codeToLabel(code) || code,
      reasonText,
      reportStatus: alreadyDone ? report.status : 'expired',
      deadlineAt: report.deadlineAt,
      timezone: settings.timezone || 'Europe/Moscow',
      reportItemId: report.reportItemId,
      portalDomain: String(context.domain || ''),
      context
    });
  } catch (fwdError) {
    console.warn('bot_reason_forward_failed', { reportId, message: fwdError.message, code: fwdError.code, status: fwdError.statusCode });
  }
};
const botCommandHandler = createBotCommandHandler({
  bitrixClient,
  reasonStore,
  reasonCaptureStore,
  onReasonCaptured: onBotReasonCaptured,
  getReasons: getBotReasons
});
const getAdminContext = async () => {
  const entry = await authContextStore.getLastAdminContext();
  if (!entry?.context) return {};
  return { key: entry.key, ...entry.context };
};
const bitrixSettingsStore = createBitrixAppSettingsStore({
  bitrixClient,
  optionKey: process.env.BITRIX_APP_SETTINGS_OPTION_KEY || 'azs_photo_report_settings_v1'
});
// Durable plan mirror in Bitrix app.option (survives redeploy that wipes the DB).
const dispatchPlanMirror = createDispatchPlanMirror({ bitrixClient, planStore: dispatchPlanStore });
// Inbound-webhook context for background tasks (generation/execution) — works
// after a redeploy when no admin has opened the app. Empty env → no webhook,
// scheduler falls back to the admin OAuth context (legacy behavior).
const webhookBackgroundContext = buildWebhookContext(process.env.BITRIX_WEBHOOK_URL || '');
const settingsStore = createCompositeSettingsStore({
  bitrixStore: bitrixSettingsStore,
  dbStore: dbSettingsStore,
  getDefaultContext: async () => {
    const entry = await authContextStore.getLastAdminContext();
    if (!entry?.context) {
      return {};
    }
    return {
      key: entry.key,
      ...entry.context
    };
  }
});
const botRegistryService = createBotRegistryService({ bitrixClient });
// Id бота нигде в проекте не читается из окружения на момент старта — бот
// регистрирует себя сам (см. botRegistryService.ensureBot), поэтому id
// становится известен только под конкретным authId, уже внутри запроса.
// Один резолвер на botRegistryService, используется и notificationService,
// и (ниже, Task 12) diagChatNotifier — чтобы не заводить вторую копию этой
// логики и не создавать второй экземпляр реестра.
const resolveBotIdViaRegistry = async (context = {}) => {
  const authId = String(context?.authId || context?.auth_id || '').trim();
  if (!authId) {
    return 0;
  }
  const registration = await botRegistryService.ensureBot({ authId, context });
  return registration.botId;
};
const notificationService = createNotificationService({
  bitrixClient,
  adminUserIds: String(process.env.SYSTEM_ADMIN_USER_IDS || process.env.ADMIN_USER_IDS || '')
    .split(/[\s,]+/).map(Number).filter(Boolean),
  resolveBotId: resolveBotIdViaRegistry,
  ensureBot: async (context = {}) => {
    const authId = String(context?.authId || '').trim();
    if (!authId) return { botId: 0 };
    return botRegistryService.ensureBot({ authId, context });
  }
});
const timeoutWatcher = createTimeoutWatcher({
  reportsStore,
  dispatchLogStore,
  bitrixClient,
  settingsStore,
  notificationService,
  reasonStore
});
const dispatchService = createDispatchService({
  dispatchLogStore,
  settingsStore,
  bitrixClient,
  notificationService,
  timeoutWatcher
});
const photoRemarkService = createPhotoRemarkService({
  bitrixClient,
  remarkStore: photoRemarkStore,
  reportsStore,
  settingsStore,
  getAdminContext
});
const verifyToken = createVerifyToken({ authContextStore });
// S1 (ревью): гвард для /ping и /echo — проверяет подпись/срок действия JWT,
// но не трогает authContextStore (см. utils/verifyToken.js). Используется
// только при монтировании /api/diag ниже (DIAG_SIGNATURE_ONLY_PATHS).
const verifyTokenSignatureOnly = createVerifyTokenSignatureOnly();
const attachAccessContext = async (req, res, next) => {
  try {
    const settings = await settingsStore.read({
      context: req.bitrixContext || {}
    });
    const context = resolveAccessContext({
      userId: Number(req.user?.user_id || req.user?.id || 0),
      isPortalAdmin: Boolean(req.bitrixContext?.isAdmin),
      settings
    });
    req.accessContext = context;
    return next();
  } catch (error) {
    return res.status(500).json({
      error: 'access_context_failed',
      message: error.message
    });
  }
};

app.get('/', (_req, res) => {
  res.json([
    '!default route for index page, please use /api/* routes'
  ]);
});

// Public liveness/readiness probes — both auth-free.
// /api/livez: always 200 (process is up).
// /api/healthz: 200 if DB is reachable, 503 otherwise (≤2 s timeout).
app.get('/api/livez', (_req, res) => res.json({ ok: true }));

app.get('/api/healthz', async (_req, res) => {
  // Per-query timeout (1800 ms) cancels the query at the driver level and
  // releases the pool slot even if the DB is hung. Without this, every
  // healthcheck probe (every 30 s) would leave a dangling pool checkout,
  // eventually exhausting the pool.
  // Note: this is intentionally NOT a global pool-level timeout — long
  // analytical queries must not be cut off mid-flight.
  // The outer race (2 s) is kept as a second line of defence.
  const probeQuery = dbType === 'mysql'
    ? { sql: 'SELECT 1', timeout: 1800 }        // mysql2: per-query timeout
    : { text: 'SELECT 1', query_timeout: 1800 }; // pg: client-side query_timeout
  try {
    await Promise.race([
      pool.query(probeQuery),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('db healthcheck timeout')), 2000).unref()
      ),
    ]);
    res.json({ ok: true });
  } catch (error) {
    res.status(503).json({ ok: false, error: 'db_unavailable' });
  }
});

app.get('/api/health', verifyToken, attachAccessContext, (req, res) => {
  res.json({
    status: 'healthy',
    backend: 'node',
    timestamp: Math.floor(Date.now() / 1000),
    role: req.accessContext?.role || null,
    capabilities: req.accessContext?.capabilities || null
  });
});

app.get('/api/me/role', verifyToken, attachAccessContext, (req, res) => res.json({
  role: req.accessContext?.role || null,
  capabilities: req.accessContext?.capabilities || {},
  access: req.accessContext?.access || {}
}));

app.post('/api/admin/bot/refresh-avatar', verifyToken, attachAccessContext, async (req, res) => {
  if (!req.accessContext?.capabilities?.settings) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Admin access required'
    });
  }
  const authId = String(req.bitrixContext?.authId || req.bitrixContext?.auth_id || '').trim();
  if (!authId) {
    return res.status(400).json({
      error: 'auth_id_missing',
      message: 'Bitrix auth id is required to refresh bot avatar'
    });
  }
  try {
    const registration = await botRegistryService.ensureBot({
      authId,
      context: req.bitrixContext || {}
    });
    return res.json({
      ok: true,
      botId: registration.botId,
      reused: Boolean(registration.reused),
      registered: Boolean(registration.registered)
    });
  } catch (error) {
    return res.status(502).json({
      error: 'bot_refresh_failed',
      message: error.message
    });
  }
});

app.post('/api/admin/bot/reregister', verifyToken, attachAccessContext, async (req, res) => {
  if (!req.accessContext?.capabilities?.settings) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Admin access required'
    });
  }
  const authId = String(req.bitrixContext?.authId || req.bitrixContext?.auth_id || '').trim();
  if (!authId) {
    return res.status(400).json({
      error: 'auth_id_missing',
      message: 'Bitrix auth id is required to reregister bot'
    });
  }
  try {
    const registration = await botRegistryService.ensureBot({
      authId,
      context: req.bitrixContext || {},
      force: true
    });
    process.env.BITRIX_BOT_ID = String(registration.botId);
    if (typeof notificationService.setBotId === 'function') {
      notificationService.setBotId(registration.botId);
    }
    return res.json({
      ok: true,
      botId: registration.botId,
      registered: Boolean(registration.registered),
      reused: Boolean(registration.reused)
    });
  } catch (error) {
    return res.status(502).json({
      error: 'bot_reregister_failed',
      message: error.message
    });
  }
});

app.use('/api/settings', verifyToken, attachAccessContext, createSettingsRouter({ store: settingsStore }));
app.use('/api/jobs', verifyToken, attachAccessContext, createDispatchRouter({ dispatchService }));
app.use('/api/reports', verifyToken, attachAccessContext, createReportsRouter({
  reportsStore,
  dispatchService,
  settingsStore,
  bitrixClient,
  notificationService,
  authContextStore,
  crmSyncJobStore,
  dispatchPlanStore,
  dispatchPlanMirror,
  analyticsStore,
  diskApi: bitrixClient.diskApi,
  reasonStore,
  reasonForwardingService,
  getAdminContext,
  getBackgroundContext: async () => {
    if (webhookBackgroundContext) {
      return webhookBackgroundContext;
    }
    const entry = await authContextStore.getLastAdminContext();
    return entry?.context ? { key: entry.key, ...entry.context } : {};
  },
  brandStore,
  photoQueueStore,
}));

app.use('/api/reports/photos', verifyToken, attachAccessContext, createPhotoFeedRouter({
  reportsStore,
  settingsStore,
  bitrixClient,
  getAdminContext
}));

app.use('/api/photo-remarks', verifyToken, attachAccessContext, createPhotoRemarkRouter({
  remarkStore: photoRemarkStore,
  photoRemarkService,
  reportsStore,
  bitrixClient,
  getAdminContext
}));

app.use('/api/brands', verifyToken, attachAccessContext, createBrandRouter({
  brandStore,
  bitrixClient,
  getAdminContext,
  settingsStore
}));

app.use('/api/users', verifyToken, attachAccessContext, createUsersRouter({
  bitrixClient,
  getAdminContext
}));

// ping/echo — сигнатурный JWT-гвард без attachAccessContext: attachAccessContext
// читает настройки из БД на каждом запросе (server.js:439), и тогда замер RTT
// мерил бы нашу БД, а не сеть. С S1 (ревью) то же верно и для самого
// verifyToken — его полная версия ходит в authContextStore на каждый запрос,
// поэтому /ping и /echo получают createVerifyTokenSignatureOnly() вместо
// verifyToken (см. utils/verifyToken.js): подпись/срок токена по-прежнему
// проверяются и отклоняются, а БД не трогается вовсе.
//
// Нельзя смонтировать общий diagRouter отдельно на '/api/diag/ping' и
// '/api/diag/echo' до общего '/api/diag': Express обрезает совпавший префикс
// маршрута use(), и роутер получает остаток '/'. Ни один маршрут внутри
// diagRouter не совпадает с '/', поэтому запрос проваливается дальше по
// стеку и всё равно попадает под '/api/diag' с attachAccessContext —
// проверено эмпирически (verifyToken вызывался дважды, attachAccessContext
// один раз для /ping и /echo). Поэтому исключение сделано условными
// мидлварями внутри одного монтирования на '/api/diag': req.path здесь уже
// относительный (совпадение с '/ping'/'/echo'), Express обрезает префикс
// до вызова мидлварей этого use(). DIAG_SIGNATURE_ONLY_PATHS общий с
// tests/diagAuthDispatch.test.js — тот же Set, что и здесь.
//
// diagStore === null (СУБД не PostgreSQL) — весь мониторинг просто не
// монтируется, без него роутер не может ни во что писать.
//
// Проба Диска в diagSelfCheck ниже звонит через СВОЙ, отдельный от боевого
// bitrixClient (выше) клиент. Причина — боевой инцидент 2026-07-31
// (~4200 упавших загрузок за два часа на 15 АЗС): у боевого bitrixClient
// включены ретраи транзиентных ошибок — RETRY_BACKOFF_MS = [800, 1600, 3200]
// в bitrixRestClient.js, то есть 5600 мс сна ещё ДО самих сетевых попыток. У
// пробы Диска (diskTimeoutMs в serverSelfCheck.js) таймаут по умолчанию —
// 5000 мс, поэтому она физически не могла пережить цикл ретраев: таймаут
// пробы срабатывал раньше, чем клиент успевал вернуть настоящую ошибку
// Bitrix. Логи сервера в это время показывали wrong_client 143 раза за пять
// минут открытым текстом, а срез вместо этого писал errorCode: null,
// errorMessage: "disk_timeout" на 147 бандлах подряд — главный сигнал, ради
// которого этот срез существует, глушился нашей же машинерией ретраев.
// Разбор — в комментарии над параметром diskClient в serverSelfCheck.js.
//
// retryBackoffMs: [] выключает именно цикл ретраев транзиентных ошибок:
// проба — измерение, а не боевая работа, ей нужен первый быстрый честный
// ответ, а не устойчивость к сбоям. Один авторефреш токена при refreshable
// auth-ошибке (внутри callInternalWithAuthRefresh в bitrixRestClient.js) при
// этом остаётся — это и есть путь, которым настоящий wrong_client доходит до
// пробы, и он нам нужен: одна попытка, быстро, реальная ошибка.
//
// onTokenRefreshed НЕ передаётся: этот клиент — только наблюдатель пробы, он
// не имеет права молча писать обновлённый токен обратно в
// authContextStore — этим по-прежнему занимается только боевой bitrixClient
// (выше, при следующем реальном вызове). CLIENT_ID/CLIENT_SECRET/домен —
// те же дефолты из process.env, что и у боевого клиента: свои значения
// конструктору не передаём.
const diagDiskProbeClient = createBitrixRestClient({ retryBackoffMs: [] });
// Серверный срез (Task 11): состояние OAuth-контекста, живая проба Диска,
// пинг БД. Конструктор не делает I/O сам по себе, поэтому создаём его
// безусловно — таймеры и сетевые вызовы запускаются только внутри run(),
// а run() вызывается лишь из-под /api/diag/report, который смонтирован
// ниже только когда diagStore не null.
const diagSelfCheck = createServerSelfCheck({
  authContextStore,
  bitrixClient,
  diskClient: diagDiskProbeClient,
  pool
});
// Task 12: пост карточки + бандла в дежурный чат после сохранения диагностики.
// DIAG_CHAT_ID пуст по умолчанию — фича выключена, notify() тогда просто
// отдаёт disabled:true и никуда не стучится (см. diagChatNotifier.js).
// resolveContext: getAdminContext — ТОТ ЖЕ механизм, что уже используют
// photoRemarkService/usersRoutes/brandRoutes чуть выше по файлу; передавать
// сюда пустой {} нельзя — вызов imbot.v2.* тогда падает, не покинув сервер
// (см. комментарий в diagChatNotifier.js).
// resolveBotId: НЕ Number(process.env.BITRIX_BOT_ID) — этот бот регистрирует
// себя сам, id не известен на старте процесса (BITRIX_BOT_ID=0 в проде —
// норма). Тот же resolveBotIdViaRegistry, что чуть выше получает
// notificationService, — один и тот же botRegistryService, без второго
// экземпляра реестра. Читать переменную окружения здесь один раз уже было
// ошибкой: DIAG_CHAT_ID был задан верно, а нотифаер молча считал себя
// выключенным, потому что botId=0 на момент создания — нормальное состояние
// в этом проекте, а не признак отключённой фичи (см. diagChatNotifier.js).
const diagChatNotifier = createDiagChatNotifier({
  bitrixClient,
  dialogId: process.env.DIAG_CHAT_ID || '',
  resolveContext: getAdminContext,
  resolveBotId: resolveBotIdViaRegistry
});
const diagSignatureOnlyPaths = new Set(DIAG_SIGNATURE_ONLY_PATHS);
if (diagStore) {
  const diagRouter = createDiagRouter({ store: diagStore, serverSelfCheck: diagSelfCheck, chatNotifier: diagChatNotifier });
  app.use('/api/diag', (req, res, next) => {
    if (diagSignatureOnlyPaths.has(req.path)) return verifyTokenSignatureOnly(req, res, next);
    return verifyToken(req, res, next);
  }, (req, res, next) => {
    if (diagSignatureOnlyPaths.has(req.path)) return next();
    return attachAccessContext(req, res, next);
  }, diagRouter);
  // Fix round (ревью, live-run): ошибки парсера тела (битый JSON, превышен
  // лимит размера) бросают ДО обработчика маршрута — эта мидлварь обязана
  // стоять сразу после диаг-роутера, иначе такие запросы долетают до
  // дефолтного HTML-обработчика ошибок Express. См. createDiagErrorHandler
  // в diagMiddleware.js.
  app.use('/api/diag', createDiagErrorHandler());
}
// Диагностика отключена (например, неподдерживаемая СУБД). Отвечаем в том же
// JSON-контракте, что и остальное приложение: голый HTML-404 от Express
// фронтенд разбирает как SyntaxError и показывает оператору не отказ, а сбой.
// Fix round (ревью, S2): сам обработчик теперь живёт в src/diag/diagMiddleware.js —
// tests/diagBootGuard.test.js импортирует ровно эту функцию, а не свою копию.
if (!diagStore) {
  app.use('/api/diag', createDiagUnavailableHandler());
}

// ---------------------------------------------------------------------------
// BUG-019: Bot event handler — receives ONIMBOTMESSAGEADD from Bitrix24.
// Bitrix posts event data to the handler URL that was registered on install.
// This route is intentionally public (no JWT): Bitrix cannot add our JWT.
// The bot event handler performs two duties:
//   1. COMMAND event: user pressed «Указать причину» COMMAND button → bot replies
//      «Напишите причину одним сообщением» and records awaiting state.
//   2. Plain message: if user/dialog is in awaiting state, capture the text as
//      reason via reasonStore, reply «Причина принята», clear awaiting state.
//
// SECURITY: The handler URL registered with Bitrix24 includes ?s=<JOB_SECRET>.
// When JOB_SECRET is configured, any request without the correct ?s param is
// silently ignored (fail-closed): returns 200 {ok:true,handled:false} so that
// Bitrix24's retry mechanism does not keep hammering the endpoint.
// When JOB_SECRET is NOT set the endpoint is ALSO fail-closed: a one-time
// warning is logged and the request is rejected. Without a secret the bot
// callback URL is already misconfigured, so failing closed is safe (BUG-S2).
// ---------------------------------------------------------------------------

// One-time warning flag: log once per process lifetime when no secret is set.
let _botEventUnverifiedWarned = false;

app.post('/api/bot/event', async (req, res) => {
  try {
    // ── SECURITY GATE ─────────────────────────────────────────────────────────
    const decision = checkBotEventSecret(process.env.JOB_SECRET, req.query.s);
    if (decision === 'reject') {
      console.warn('/api/bot/event: rejected — wrong or missing ?s param (possible spoofed request)');
      return res.json({ ok: true, handled: false });
    }
    if (decision === 'no-secret') {
      if (!_botEventUnverifiedWarned) {
        _botEventUnverifiedWarned = true;
        console.warn('/api/bot/event: JOB_SECRET is not set — endpoint is UNVERIFIED; set JOB_SECRET in production');
      }
      return res.json({ ok: true, handled: false });
    }
    // decision === 'ok' → fall through and process the event
    // ── END SECURITY GATE ─────────────────────────────────────────────────────

    // Bitrix24 chat-bots 2.0 deliver events in webhook mode as
    // application/x-www-form-urlencoded with PHP-nested keys. The «Указать
    // причину» button is an ACTION:SEND button, so pressing it SENDS the text
    // "/reason <reportId>" as a user message → fires ONIMBOTV2MESSAGEADD.
    //   v2 shape:  data.message.text / data.chat.dialogId / data.message.authorId|data.user.id
    //   v1 shape (fallback): data.PARAMS.MESSAGE / DIALOG_ID / FROM_USER_ID
    const body = req.body || {};
    const data = body?.data || {};
    const v1params = data?.PARAMS || body?.PARAMS || {};
    const event = String(body?.event || body?.EVENT || data?.EVENT || '').toUpperCase();

    const messageText = String(
      data?.message?.text ?? v1params?.MESSAGE ?? v1params?.message ?? ''
    ).trim();
    const userId = Number(
      data?.message?.authorId ?? data?.user?.id ?? v1params?.FROM_USER_ID ?? v1params?.from_user_id ?? 0
    );
    const dialogId = String(
      data?.chat?.dialogId ?? v1params?.DIALOG_ID ?? v1params?.dialog_id ?? (userId ? `u${userId}` : '')
    );

    // Build a minimal auth context for reply callbacks (best-effort).
    const context = {
      authId: String(body?.auth?.access_token || data?.bot?.auth?.access_token || ''),
      domain: String(body?.auth?.domain || ''),
      memberId: String(body?.auth?.member_id || '')
    };

    const isMessageEvent = event === 'ONIMBOTV2MESSAGEADD' || event === 'ONIMBOTMESSAGEADD';
    // Ignore the bot's OWN messages (its replies), or unidentified senders, to
    // avoid the reply «Напишите причину» being consumed as the reason (loop).
    const botSelfId = Number(data?.bot?.id || process.env.BITRIX_BOT_ID || 0);
    const authorIsBot = String(data?.user?.bot) === 'true' || String(data?.user?.bot) === '1'
      || (botSelfId > 0 && userId === botSelfId);
    if (!isMessageEvent || !userId || authorIsBot) {
      return res.json({ ok: true, handled: false });
    }

    // Button press: "/reason <reportId>" (strict — a plain reason containing a
    // number must NOT be mistaken for the trigger).
    const reasonTrigger = messageText.match(/^\/reason\s+(\d+)\s*$/i);
    if (reasonTrigger) {
      const reportId = Number(reasonTrigger[1]);
      let azsId = '';
      try {
        const report = await reportsStore.getById(reportId);
        azsId = String(report?.azsId || '');
      } catch {
        // best-effort: azsId may be empty; reason will still be stored
      }
      await botCommandHandler.handleCommand({ userId, dialogId, reportId, azsId, context });
      return res.json({ ok: true, handled: true, action: 'awaiting_reason' });
    }

    // REASON-BTN-TEXT: нажата кнопка причины (человеческая фраза, без id в тексте).
    // Находим активный отчёт пользователя сами и просим причину по нему. Блок /reason N
    // выше — legacy-путь (ручной ввод / старые сообщения / notify-фоллбэк) сохранён.
    if (isReasonButtonPress(messageText)) {
      let activeReport = null;
      try {
        const items = await reportsStore.listActiveByAdminUserId({ adminUserId: userId, limit: 1 });
        activeReport = Array.isArray(items) && items.length ? items[0] : null;
      } catch (lookupError) {
        console.warn('bot_reason_active_lookup_failed', { userId, message: lookupError.message });
      }
      if (activeReport?.id) {
        await botCommandHandler.handleCommand({
          userId,
          dialogId,
          reportId: Number(activeReport.id),
          azsId: String(activeReport.azsId || ''),
          context
        });
        return res.json({ ok: true, handled: true, action: 'awaiting_reason' });
      }
      return res.json({ ok: true, handled: false, action: 'no_active_report' });
    }

    if (messageText) {
      // Plain message — captured as the reason only if this user is awaiting.
      const handled = await botCommandHandler.handleMessage({ userId, dialogId, text: messageText, context });
      return res.json({ ok: true, handled, action: handled ? 'reason_captured' : 'ignored' });
    }

    return res.json({ ok: true, handled: false });
  } catch (error) {
    console.error('/api/bot/event error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/install', async (req, res) => {
  try {
    console.log('/api/install', maskAuthFields(req.body));
    const botMode = String(process.env.BITRIX_BOT_MODE || 'notify').trim().toLowerCase();
    const authId = String(req.body?.AUTH_ID || '').trim();
    const refreshToken = String(req.body?.REFRESH_TOKEN || req.body?.REFRESH_ID || '').trim();
    const domain = String(req.body?.DOMAIN || '').trim().toLowerCase();
    const memberId = String(req.body?.member_id || '').trim();
    const userId = parseUserId(req.body?.user_id);
    const appSid = String(req.body?.APP_SID || '').trim();

    // BUG-S1: capture application_token for future event-callback verification.
    const applicationToken = String(
      req.body?.auth?.application_token ?? req.body?.application_token ?? ''
    ).trim();

    const installContext = buildInstallContext({
      authId,
      refreshToken,
      domain,
      memberId,
      userId,
      appSid
    });

    if (authId || refreshToken || domain || memberId || userId) {
      // BUG-S1 fix: verify via Bitrix profile before granting isAdmin.
      // Previously isAdmin:true was granted unconditionally — any forged POST
      // with attacker-chosen fields would receive admin. Now:
      //   - authId present → call Bitrix profile with fail-fast cap; derive isAdmin.
      //   - authId absent  → isAdmin:false (no way to verify).
      //   - Bitrix call throws or exceeds timeoutMs → isAdmin:false + warn; install
      //     still succeeds. A real portal admin re-verifies on the very next
      //     /api/getToken (which already sets isAdmin from profile.ADMIN), so this
      //     self-heals within the same session.
      const isAdmin = await resolveInstallAdmin({
        bitrixClient,
        authId,
        installContext
      });

      const upsertPayload = {
        ...installContext,
        isAdmin,
        // Stamp issuance time so tokenRefreshScheduler can detect the
        // ~30-day Bitrix refresh_token TTL and warn before silent death.
        refreshTokenIssuedAt: new Date().toISOString()
      };

      // Only include applicationToken when non-empty (don't overwrite an existing
      // valid token with an empty string if the field is absent from the payload).
      if (applicationToken) {
        upsertPayload.applicationToken = applicationToken;
      }

      await authContextStore.upsertContext(upsertPayload).catch((error) => {
        console.error('Failed to persist auth context on /api/install', error);
      });
    }

    const payload = {
      message: 'All success',
      placement: {
        restAppUri: false,
        alreadyExists: false,
        handler: null
      },
      bot: {
        mode: botMode,
        registered: false,
        botId: Number(process.env.BITRIX_BOT_ID || 0) || null
      }
    };

    if (authId) {
      try {
        const placementStatus = await ensureAppPlacements({
          bitrixClient,
          authId,
          context: installContext,
          handlerUrl: resolveAppHandlerUrl()
        });
        const restAppUri = placementStatus.placements.find((p) => p.code === 'REST_APP_URI');
        payload.placement = {
          restAppUri: placementStatus.bound,
          alreadyExists: Boolean(restAppUri?.alreadyExists),
          handler: placementStatus.handler,
          placements: placementStatus.placements
        };
      } catch (error) {
        return res.status(502).json({
          error: 'rest_app_uri_bind_failed',
          message: error.message,
          placement: payload.placement,
          bot: payload.bot
        });
      }
    }

    if (botMode !== 'bot') {
      return res.json(payload);
    }

    if (!authId) {
      return res.status(400).json({
        error: 'bot_auth_required',
        message: 'BITRIX_BOT_MODE=bot requires AUTH_ID in /api/install payload'
      });
    }

    try {
      const registration = await botRegistryService.ensureBot({ authId, context: installContext });
      process.env.BITRIX_BOT_ID = String(registration.botId);
      if (typeof notificationService.setBotId === 'function') {
        notificationService.setBotId(registration.botId);
      }
      return res.json({
        ...payload,
        bot: {
          mode: botMode,
          registered: Boolean(registration.registered),
          reused: Boolean(registration.reused),
          botId: registration.botId,
          bots: registration.bots || []
        }
      });
    } catch (error) {
      return res.status(502).json({
        error: 'bot_register_failed',
        message: error.message,
        bot: payload.bot
      });
    }
  } catch (error) {
    return res.status(500).json({
      error: 'install_failed',
      message: error.message
    });
  }
});

app.post('/api/getToken', async (req, res) => {
  try {
    console.log('/api/getToken', maskAuthFields(req.body));
    const authId = String(req.body?.AUTH_ID || '').trim();
    const refreshToken = String(req.body?.REFRESH_TOKEN || req.body?.REFRESH_ID || '').trim();
    const domain = String(req.body?.DOMAIN || '').trim().toLowerCase();
    const memberId = String(req.body?.member_id || '').trim();
    const userId = parseUserId(req.body?.user_id);
    const appSid = String(req.body?.APP_SID || '').trim();

    if (!authId || !refreshToken || !domain || !memberId || !userId) {
      return res.status(400).json({
        error: 'invalid_auth_payload',
        message: 'AUTH_ID, REFRESH_TOKEN, DOMAIN, member_id and user_id are required'
      });
    }

    const contextDraft = {
      memberId,
      domain,
      userId,
      authId,
      refreshToken,
      appSid
    };

    const [profile, appInfo] = await Promise.all([
      bitrixClient.callMethodWithAuth('profile', {}, authId, contextDraft),
      bitrixClient.callMethodWithAuth('app.info', {}, authId, contextDraft)
    ]);

    const profileUserId = parseUserId(profile?.ID ?? profile?.id);
    if (!profileUserId || profileUserId !== userId) {
      return res.status(401).json({
        error: 'user_mismatch',
        message: `profile.ID (${profileUserId || 0}) does not match user_id (${userId})`
      });
    }
    if (!appInfo || typeof appInfo !== 'object') {
      return res.status(401).json({
        error: 'invalid_app_context',
        message: 'app.info did not return valid app context'
      });
    }

    // Preserve admin elevation when profile.ADMIN is missing/undefined in the
    // response. Only an explicit boolean from Bitrix should change isAdmin.
    // This prevents portal admins from being silently downgraded on a routine
    // /api/getToken call where Bitrix omits the ADMIN field.
    // BUG-A1: demotion via stale request body prevented — see src/auth/resolveIsAdmin.js.
    const profileAdminRaw = profile?.ADMIN;
    const requestAdminRaw = pickFirstDefined(
      req.body?.is_admin,
      req.body?.IS_ADMIN,
      req.body?.admin,
      req.body?.ADMIN
    );
    const previousContext = await authContextStore.getContext(contextDraft) || {};
    const isAdmin = resolveIsAdmin({
      profileAdminRaw,
      requestAdminRaw,
      previousIsAdmin: Boolean(previousContext.isAdmin)
    });
    await authContextStore.upsertContext({
      ...contextDraft,
      isAdmin,
      verifiedAt: new Date().toISOString(),
      // Fresh OAuth tokens delivered through the Bitrix iframe — refresh
      // issuance time resets here too.
      refreshTokenIssuedAt: new Date().toISOString()
    });

    const token = jwt.sign({
      sub: userId,
      domain,
      member_id: memberId
    }, process.env.JWT_SECRET, { expiresIn: '1h' });

    return res.json({ token });
  } catch (error) {
    return res.status(500).json({
      error: 'token_issue_failed',
      message: error.message
    });
  }
});

const PORT = process.env.PORT || 8000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

dispatchLogStore.ensureSchema()
  .then(() => {
    console.log('dispatch_log schema is ready');
  })
  .catch((error) => {
    console.error('Failed to prepare dispatch_log schema', error);
  });

settingsStore.ensureSchema()
  .then(() => {
    console.log('app_settings schema is ready');
  })
  .catch((error) => {
    console.error('Failed to prepare app_settings schema', error);
  });

// Named (не анонимная цепочка) — Task 11 ниже (проводка воркера/сторожа
// публикации фото) вешает СВОЙ .then()/.catch() на этот же промис вместо
// повторного вызова ensurePhotoSchema(): сам метод идемпотентен и второй
// вызов был бы безопасен, но незачем повторно гонять DDL/information_schema
// проверки при каждом старте процесса, когда один и тот же результат можно
// разделить между двумя независимыми подписчиками.
const reportPhotoSchemaReady = reportsStore.ensurePhotoSchema();
reportPhotoSchemaReady
  .then(() => {
    console.log('report_photo schema is ready');
  })
  .catch((error) => {
    console.error('Failed to prepare report_photo schema', error);
  });

crmSyncJobStore.ensureSchema()
  .then(() => console.log('crm_sync_jobs schema is ready'))
  .catch((error) => console.error('Failed to prepare crm_sync_jobs schema', error));

reasonStore.ensureSchema()
  .then(() => console.log('report_reason schema is ready'))
  .catch((error) => console.error('Failed to prepare report_reason schema', error));

photoRemarkStore.ensureSchema()
  .then(() => console.log('photo_remark schema is ready'))
  .catch((error) => console.error('Failed to prepare photo_remark schema', error));

brandStore.ensureSchema()
  .then(() => console.log('brand schema is ready'))
  .catch((error) => console.error('Failed to prepare brand schema', error));

if (diagStore) {
  diagStore.ensureSchema()
    .then(() => console.log('diag_report schema is ready'))
    .catch((error) => console.error('Failed to prepare diag_report schema', error));
}

if (typeof authContextStore.ensureSchema === 'function') {
  authContextStore.ensureSchema()
    .then(() => console.log('auth_context schema is ready'))
    .catch((error) => console.error('Failed to prepare auth_context schema', error));
}

const scheduler = createDispatchScheduler({
  dispatchService,
  getCandidates: () => readDispatchCandidates(),
  settingsStore,
  bitrixClient,
  getRuntimeContext: async () => {
    const entry = await authContextStore.getLastAdminContext();
    if (!entry?.context) {
      // Strict mode: no admin context = scheduler MUST skip the tick rather
      // than fall back to a regular user token (which would silently fail on
      // REST methods that need admin scope, e.g. crm.item.add for some SPAs).
      console.warn('scheduler.skip: no admin context available');
      return {};
    }
    return {
      key: entry.key,
      ...entry.context
    };
  },
  timeoutWatcher,
  enabled: String(process.env.SCHEDULER_ENABLED || 'false').toLowerCase() === 'true',
  cronExpression: process.env.DISPATCH_CRON || '* * * * *',
  timeoutCronExpression: process.env.TIMEOUT_CRON || '*/5 * * * *',
  // Randomized plan-then-execute mode (ON by default; DISPATCH_PLAN_MODE_ENABLED=false
  // reverts to legacy slot-minute dispatch). The scheduler generates a daily
  // randomized plan and fires each AZS at its own jittered time.
  dispatchPlanStore,
  generateDailyPlan,
  // Resilience: background context (webhook if configured, else admin fallback),
  // durable plan mirror in Bitrix, and a reviewer alert when no plan exists.
  getBackgroundContext: async () => {
    if (webhookBackgroundContext) {
      return webhookBackgroundContext;
    }
    const entry = await authContextStore.getLastAdminContext();
    return entry?.context ? { key: entry.key, ...entry.context } : {};
  },
  planMirror: dispatchPlanMirror,
  notificationService,
  getReviewerUserIds: async () => {
    try {
      const settings = await settingsStore.read();
      return Array.isArray(settings?.access?.reviewerUserIds) ? settings.access.reviewerUserIds : [];
    } catch {
      return [];
    }
  },
  // S8-БЛОКЕР #1: прошиваем reportsStore + dispatchLogStore в scheduler.
  // reportsStore — проверка статуса отчёта при reminder (OR-6, без CRM-запроса).
  // dispatchLogStore — идемпотентность reminder через reserve + finishStalePlannedSlots (BUG-009).
  reportsStore,
  dispatchLogStore
  // planModeEnabled / planGenerationCron / executeBatchLimit read from env inside the scheduler.
});

scheduler.start().catch((error) => {
  console.error('Failed to start scheduler', error);
});

const crmSyncWorker = createCrmSyncWorker({
  store: crmSyncJobStore,
  runSync: buildCrmSyncRunner({ reportsStore, settingsStore, bitrixClient, authContextStore }),
  backoffMs: [800, 1600, 3200],
  pollIntervalMs: Number(process.env.CRM_SYNC_POLL_MS || 1000),
  isRetryable: (error) => RETRYABLE_TRANSIENT_ERROR_PATTERN.test(String(error?.message || error || ''))
});
if (String(process.env.CRM_SYNC_WORKER_ENABLED || 'true').toLowerCase() === 'true') {
  // Crash recovery first: re-queue any 'running' jobs orphaned by a previous
  // process that died mid-run, otherwise their reports never sync again.
  crmSyncWorker.recover()
    .then((n) => { if (n) console.log(`crm_sync reclaimed ${n} stale running job(s)`); })
    .catch((error) => console.error('crm_sync reclaim failed', error))
    .finally(() => {
      crmSyncWorker.start();
      console.log('crm_sync worker started');
    });
}

// ---------------------------------------------------------------------------
// Очередь публикации фото — воркер, ограничитель темпа, сторож (Task 11).
//
// ОДИН ограничитель на процесс — общий и для publishOne (реальные вызовы
// Bitrix Disk через photoPublisher ниже), и для photoPublishWorker
// (penalize() на Retry-After от портала). Отдельный экземпляр на
// потребителя означал бы несколько независимых бюджетов вместо одного
// общего — то есть кратно превышенный предел портала (2 запроса в секунду
// на всю компанию), ровно тот инцидент (31 июля — ~4200 упавших фото,
// 3 августа — 2420 отказов подряд), который вся эта задача лечит.
//
// Значения окружения валидируются ДО конструктора (readPhotoPublishNumberEnv,
// photoPublishBoot.js): createRateLimiter бросает при ratePerSec<=0 или
// burst<1, createPhotoPublishWorker бросает при workers<1 — кривая или
// нечисловая переменная окружения не имеет права уронить старт процесса
// (приём фото не имеет права упасть из-за проводки).
// ---------------------------------------------------------------------------
const photoRateLimiter = createRateLimiter({
  ratePerSec: readPhotoPublishNumberEnv({
    rawValue: process.env.PHOTO_PUBLISH_RATE_PER_SEC,
    fallback: 1.4,
    isValid: (n) => n > 0,
    name: 'PHOTO_PUBLISH_RATE_PER_SEC'
  }),
  burst: readPhotoPublishNumberEnv({
    rawValue: process.env.PHOTO_PUBLISH_BURST,
    fallback: 3,
    isValid: (n) => n >= 1,
    name: 'PHOTO_PUBLISH_BURST'
  })
});

// Тот же приём, что getBackgroundContext у createReportsRouter выше и
// scheduler.getRuntimeContext ниже: webhook-контекст, если настроен, иначе
// последний известный admin-контекст. Отдельная копия, а не общая функция —
// намеренно: обе существующие инлайновые версии уже дублируют друг друга
// без общей функции, а факторинг третьей копии в рамках этой задачи означал
// бы трогать неродственный код (роутер отчётов, шедулер), который эта
// задача не меняет.
const getPhotoPublishBackgroundContext = async () => {
  if (webhookBackgroundContext) {
    return webhookBackgroundContext;
  }
  const entry = await authContextStore.getLastAdminContext();
  return entry?.context ? { key: entry.key, ...entry.context } : {};
};

let photoPublishWorker = null;
let photoPublishWatchdog = null;

// isPhotoPublishWorkerSupported (photoPublishBoot.js): photoQueueStore.js
// поддерживает и Postgres, и MySQL (у каждого метода есть оба варианта), но
// advisory-лок photoPublishWorker.js — Postgres-специфичный SQL
// (pg_try_advisory_lock/pg_advisory_unlock), требует pool.connect(), а у
// mysql2/promise.Pool такого метода нет (только .getConnection()). Без этой
// проверки на DB_TYPE=mysql с включённой очередью createPhotoPublishWorker
// бросил бы синхронно и уронил бы ВЕСЬ процесс — приём фото (который на
// MySQL работает штатно) тоже перестал бы работать, хотя мог бы. Приём фото
// остаётся полностью доступен в любом случае: этот флаг решает только,
// стартует ли ПУБЛИКАЦИЯ.
const photoPublishWorkerSupported = photoQueueRuntime.enabled && isPhotoPublishWorkerSupported({ pool });

if (photoPublishWorkerSupported) {
  // try/catch вокруг ВСЕЙ синхронной сборки — защита загрузки в глубину.
  // Ни один из этих четырёх конструкторов не должен быть способен уронить
  // процесс (все их собственные обязательные проверки параметров уже
  // выполнены аргументами, которые собраны здесь и должны быть корректны),
  // но если что-то непредвиденное всё же бросит — приём фото
  // (photoQueueStore.accept(), уже проверен и работает выше) не должен
  // зависеть от этого: воркер и сторож просто останутся null.
  try {
    const photoPublisher = createPhotoPublisher({
      bitrixClient,
      settingsStore,
      reportsStore,
      brandStore,
      limiter: photoRateLimiter,
      resolveContext: getPhotoPublishBackgroundContext
    });

    // Отложенная проверка слота (slot_verified=false, см. заголовочный
    // комментарий photoPublishWorker.js) — конкретная привязка к Битриксу
    // (bitrixClient/settingsStore/reportsStore.getById для azsId) собирается
    // ЗДЕСЬ, проводкой server.js, а не внутри самого воркера: тот остаётся
    // чистой DI-функцией, проверяемой без реального Битрикса.
    const resolvePhotoPublishRequiredCodes = async (task) => {
      const report = await reportsStore.getById(task.report_id);
      if (!report) return [];
      const context = await getPhotoPublishBackgroundContext();
      const settings = await settingsStore.read({ context });
      const requiredPhotos = await readRequiredPhotos({
        bitrixClient,
        settings,
        azsId: report.azsId,
        context
      });
      return requiredPhotos.map((photo) => photo.code);
    };

    // syncReportToCrmIfComplete (photoPublishCompletion.js) зовётся воркером
    // СРАЗУ после каждого успешного markPublished — см. finishPublished в
    // photoPublishWorker.js. task (второй, необязательный аргумент воркера)
    // здесь не нужен: reportId достаточно, остальной контекст проверка
    // добирает сама через reportsStore/photoQueueStore/crmSyncJobStore.
    const syncPhotoReportToCrmIfComplete = async (reportId) => {
      const context = await getPhotoPublishBackgroundContext();
      return syncReportToCrmIfComplete({
        reportId,
        reportsStore,
        photoQueueStore,
        crmSyncJobStore,
        context
      });
    };

    photoPublishWorker = createPhotoPublishWorker({
      store: photoQueueStore,
      publishOne: photoPublisher.publishOne,
      limiter: photoRateLimiter,
      pool,
      workers: readPhotoPublishNumberEnv({
        rawValue: process.env.PHOTO_PUBLISH_WORKERS,
        fallback: 3,
        isValid: (n) => n >= 1,
        name: 'PHOTO_PUBLISH_WORKERS'
      }),
      resolveRequiredPhotoCodes: resolvePhotoPublishRequiredCodes,
      reportsStore,
      syncCrmIfComplete: syncPhotoReportToCrmIfComplete
    });

    // Сторож застрявших фото (Task 10) — обязан работать под тем же ведущим
    // экземпляром, что и воркер: его собственная защита от повторных
    // уведомлений живёт в памяти ЭТОГО процесса, и при нескольких экземплярах
    // приложения на Timeweb несколько независимых сторожей дали бы несколько
    // независимых потоков уведомлений в один чат. Не заводим второй механизм
    // лидерства — переиспользуем advisory-лок воркера через isLeader().
    //
    // "Не настроено" (пустой PHOTO_WATCHDOG_CHAT_ID и DIAG_CHAT_ID) — тихий
    // no-op, тот же контракт, что и enabled=false в diagChatNotifier.js:
    // фича осознанно выключена, а не сломана.
    //
    // "Не лидер" — БРОСАЕТ, а не тихо резолвится. Антиспам-память сторожа
    // (lastSignature/lastNotifiedAtMs в photoPublishWatchdog.js) обновляется
    // ТОЛЬКО на успешный notify(). Если follower тихо "успешно" ничего не
    // отправит, его собственная память всё равно отметится как "уже
    // предупредили" — и после смены лидерства (прежний лидер упал или его
    // передеплоили) новый лидер унаследует чужую, никогда не доставленную
    // память и промолчит про уже известную проблему до истечения
    // reminderIntervalMs. Throw здесь ловится try/catch внутри самого
    // photoPublishWatchdog.js (runOnce) — тик не падает, просто ничего не
    // отправляется, и следующая попытка (в том числе от нового лидера) не
    // подавлена чужой памятью.
    const notifyPhotoPublishWatchdog = async ({ text }) => {
      const dialogId = String(process.env.PHOTO_WATCHDOG_CHAT_ID || process.env.DIAG_CHAT_ID || '').trim();
      if (!dialogId) {
        return;
      }
      if (!photoPublishWorker.isLeader()) {
        throw new Error('photo_publish_watchdog_not_leader');
      }
      const context = await getPhotoPublishBackgroundContext();
      const botId = await resolveBotIdViaRegistry(context);
      if (!botId) {
        throw new Error('photo_publish_watchdog_no_bot_id');
      }
      await bitrixClient.callMethod('imbot.v2.Chat.Message.send', {
        botId,
        dialogId,
        fields: { message: text, urlPreview: false }
      }, context);
    };

    photoPublishWatchdog = createPhotoPublishWatchdog({
      store: photoQueueStore,
      notify: notifyPhotoPublishWatchdog
    });

    // Старт — ПОСЛЕ готовности схемы (report_photo.slot_verified,
    // report_photo_blob, индексы — reportPhotoSchemaReady определён выше),
    // тем же приёмом .then()/.catch() без top-level await, что и остальная
    // проводка стартов в этом файле. Отказ схемы (например, недостаточные
    // права DDL) не должен ронять процесс — воркер и сторож просто не
    // стартуют; приём фото (photoQueueStore.accept()) от этого не зависит.
    reportPhotoSchemaReady
      .then(() => {
        photoPublishWorker.start();
        photoPublishWatchdog.start();
        console.log(JSON.stringify({ event: 'photo_publish_queue_started' }));
      })
      .catch((error) => {
        console.error(JSON.stringify({
          event: 'photo_publish_queue_start_failed',
          reason: error.message
        }));
      });
  } catch (error) {
    // Защита загрузки в глубину (см. комментарий выше try): если сборка
    // всё-таки бросила, откатываем обе ссылки на null — shutdown() и
    // остальной код ниже проверяют их через ?. и не должны увидеть
    // наполовину собранный воркер без сторожа или наоборот.
    photoPublishWorker = null;
    photoPublishWatchdog = null;
    console.error(JSON.stringify({
      event: 'photo_publish_workers_disabled',
      reason: error.message
    }));
  }
} else {
  console.log(JSON.stringify({
    event: 'photo_publish_queue_workers_skipped',
    reason: photoQueueRuntime.enabled
      ? 'pool does not support advisory-lock session affinity (pool.connect() missing — see photoPublishBoot.js: isPhotoPublishWorkerSupported); photo intake keeps working via photoQueueStore.accept(), publishing will not run'
      : photoQueueRuntime.reason
  }));
}

const tokenRefreshScheduler = createTokenRefreshScheduler({
  authContextStore,
  bitrixClient,
  enabled: String(process.env.TOKEN_REFRESH_SCHEDULER_ENABLED || 'true').toLowerCase() === 'true',
  cronExpression: process.env.TOKEN_REFRESH_CRON || '0 * * * *'
});

tokenRefreshScheduler.start();

// Ежесуточная чистка диаг-бандлов старше ретеншена (30 дней по умолчанию).
// diagStore === null (СУБД не PostgreSQL) — чистить нечего, стора нет.
if (diagStore && String(process.env.SCHEDULER_ENABLED || 'true') !== 'false') {
  cron.schedule('30 3 * * *', async () => {
    try {
      const removed = await diagStore.deleteOlderThan(Number(process.env.DIAG_RETENTION_DAYS || 30));
      console.log(JSON.stringify({ event: 'diag_retention_cleanup', removed }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'diag_retention_failed', message: error.message }));
    }
  });
}

// Startup seed: if composite mode and DB is empty, migrate file → DB once.
// This ensures a server that was previously file-only doesn't lose its admin
// context on the first deploy after upgrading to composite mode.
if (authContextStoreType === 'composite' && typeof authContextStore.seedFromFile === 'function') {
  authContextStore.seedFromFile().catch((error) => {
    console.error('auth_context seed from file failed', error);
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown — handles SIGTERM (deploy) and SIGINT (Ctrl-C / nodemon)
// ---------------------------------------------------------------------------
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const startedAt = Date.now();
  console.log(`[process] ${signal}: graceful shutdown started`);

  // Force exit after 10 s so a hung dependency never keeps the container alive.
  const force = setTimeout(() => {
    console.error('[process] shutdown timeout, forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();

  try {
    // 1. Stop accepting new HTTP requests and wait for in-flight ones to finish.
    await new Promise((resolve) => {
      server.close(resolve);
      // server.close() does not touch already-open idle keep-alive sockets
      // (nginx proxy_http_version 1.1) — without this, close waits for
      // keepAliveTimeout (~5 s) on every deploy. Active requests are not affected.
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
    });

    // 2. Stop background schedulers / workers.
    //    scheduler and tokenRefreshScheduler are always created; crmSyncWorker
    //    may not have been started (CRM_SYNC_WORKER_ENABLED=false) — optional
    //    chaining keeps shutdown safe in both cases.
    scheduler.stop?.();
    tokenRefreshScheduler.stop?.();
    crmSyncWorker.stop?.();
    // photoPublishWatchdog.stop() — синхронный, как и остальные .stop?.()
    // выше (просто снимает setInterval); может быть null, если очередь
    // публикации выключена (эфемерная БД или отказ создания стора — Task 11).
    photoPublishWatchdog?.stop?.();
    // photoPublishWorker.stop() — ОБЯЗАН быть awaited и ОБЯЗАН идти строго
    // ДО шага 4 (pool.end()) ниже. Пока лидер, воркер держит выделенный,
    // чек-аутнутый из pool клиент (advisory-лок Postgres) всю жизнь процесса
    // (см. заголовочный комментарий photoPublishWorker.js) — pool.end() ждёт
    // возврата ВСЕХ чек-аутнутых клиентов, и без предварительного stop() эта
    // конкретная попытка закрыть пул не завершится сама по себе (проверено
    // на живом Postgres).
    //
    // Раунд правок 1 (уточнение владельца): это НЕ единственная защита от
    // зависания — шаг 4 ниже уже гонит pool.end() наперегонки с 3-секундным
    // таймаутом, а весь shutdown() ещё раз подстрахован безусловным
    // force-exit через 10 с (см. начало функции). Без await stop() процесс
    // всё равно завершится — просто на 3 секунды дольше и грубее: pg
    // оборвёт соединение воркера сам, когда истечёт таймаут/наступит выход
    // процесса, и лок на стороне Postgres снимется как побочный эффект
    // обрыва, а не штатным pg_advisory_unlock. await stop() здесь — не
    // единственная страховка от зависания процесса, а более чистый путь:
    // без потери трёх секунд и со штатным снятием лока через драйвер, а не
    // через обрыв соединения. Может быть null, если очередь выключена —
    // тогда это просто no-op (Promise.resolve(undefined) через optional
    // chaining).
    await photoPublishWorker?.stop?.();

    // 3. Flush any in-flight auth-context writes so the refresh token is not lost.
    await authContextStore.flush();

    // 4. Close the DB pool. pool.end() can hang if the DB is unreachable, so we
    //    race it against a 3 s timeout — if it loses we log and proceed anyway.
    if (typeof pool.end === 'function') {
      const poolEndPromise = pool.end().catch((err) => {
        console.warn('[process] pool.end() error:', err?.message ?? err);
      });
      await Promise.race([
        poolEndPromise,
        new Promise((resolve) => setTimeout(resolve, 3000).unref())
          .then(() => { console.warn('[process] pool.end() timed out (3 s) — proceeding'); })
      ]);
    }

    console.log(`[process] graceful shutdown complete in ${Date.now() - startedAt} ms`);
  } catch (error) {
    console.error('[process] shutdown error:', error);
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
