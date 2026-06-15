// redeploy marker: 2026-06-04 (dispatch-resilience) — no functional change
import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import { createVerifyToken } from './utils/verifyToken.js';
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
import createReportsRouter, { buildCrmSyncRunner } from './src/reports/reportsRoutes.js';
import createDispatchPlanStore from './src/reports/dispatchPlanStore.js';
import { generateDailyPlan } from './src/dispatch/dispatchPlanGenerator.js';
import createDispatchPlanMirror from './src/reports/dispatchPlanMirror.js';
import { buildWebhookContext } from './src/auth/webhookContext.js';
import createCrmSyncJobStore from './src/reports/crmSyncJobStore.js';
import { createCrmSyncWorker } from './src/reports/crmSyncWorker.js';
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
import { createBotCommandHandler } from './src/notifications/botCommandHandler.js';
import { createReasonCaptureStore } from './src/notifications/reasonCaptureStore.js';
import { resolveIsAdmin } from './src/auth/resolveIsAdmin.js';
import { resolveInstallAdmin } from './src/auth/resolveInstallAdmin.js';
import { checkBotEventSecret } from './src/security/botEventGate.js';
import { validateRequiredEnv } from './utils/validateEnv.js';
import { resolvePgSslConfig } from './utils/dbSsl.js';
import { RETRYABLE_TRANSIENT_ERROR_PATTERN } from './src/shared/transientErrors.js';
import { maskAuthFields } from './utils/maskSecret.js';

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
app.use(express.json());
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

const ensureRestAppUriPlacement = async ({
  bitrixClient,
  authId,
  context,
  handlerUrl
}) => {
  if (!authId) {
    throw new Error('AUTH_ID is required to bind REST_APP_URI placement');
  }
  if (!handlerUrl) {
    throw new Error('APP_BASE_URL or VIRTUAL_HOST is required to bind REST_APP_URI placement');
  }

  const placements = await bitrixClient.callMethodWithAuth(
    'placement.get',
    {},
    authId,
    context
  );

  const list = Array.isArray(placements) ? placements : [];
  const existing = list.find((row) => String(row?.placement || '').trim() === 'REST_APP_URI');
  if (existing) {
    return {
      bound: true,
      alreadyExists: true,
      handler: String(existing.handler || handlerUrl)
    };
  }

  await bitrixClient.callMethodWithAuth(
    'placement.bind',
    {
      PLACEMENT: 'REST_APP_URI',
      HANDLER: handlerUrl,
      TITLE: 'Фото-отчёт АЗС',
      DESCRIPTION: 'Открытие отчёта АЗС по ссылке из уведомления',
      LANG_ALL: {
        ru: {
          TITLE: 'Фото-отчёт АЗС',
          DESCRIPTION: 'Открытие отчёта АЗС по ссылке из уведомления',
          GROUP_NAME: ''
        },
        en: {
          TITLE: 'AZS Photo Report',
          DESCRIPTION: 'Open AZS photo report from bot link',
          GROUP_NAME: ''
        }
      }
    },
    authId,
    context
  ).catch(async (error) => {
    if (!String(error?.message || '').includes('ERROR_PLACEMENT_MAX_COUNT')) {
      throw error;
    }
    const nextPlacements = await bitrixClient.callMethodWithAuth(
      'placement.get',
      {},
      authId,
      context
    );
    const nextList = Array.isArray(nextPlacements) ? nextPlacements : [];
    const existsAfterError = nextList.find((row) => String(row?.placement || '').trim() === 'REST_APP_URI');
    if (!existsAfterError) {
      throw error;
    }
  });

  return {
    bound: true,
    alreadyExists: false,
    handler: handlerUrl
  };
};

const dispatchLogStore = createDispatchLogStore({ pool, dbType });
const reportsStore = createReportsStore({ pool, dbType });
const analyticsStore = createAnalyticsStore({ pool, dbType });
const crmSyncJobStore = createCrmSyncJobStore({ pool, dbType });
const dispatchPlanStore = createDispatchPlanStore({ pool, dbType });
const dbSettingsStore = createDatabaseSettingsStore({ pool, dbType });
const reasonStore = createReasonStore({ pool, dbType });
const photoRemarkStore = createPhotoRemarkStore({ pool, dbType });
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
const getBotReasons = async () => {
  try {
    const settings = await settingsStore.read({ context: await backgroundContextForBot() });
    return Array.isArray(settings.report?.reasons) ? settings.report.reasons : [];
  } catch {
    return [];
  }
};
const onBotReasonCaptured = async ({ reportId, reasonCode = 'other', reasonText }) => {
  console.log('bot_reason_dbg flow_start', { reportId, reasonCode, hasReasonText: Boolean(reasonText) }); // TEMP DEBUG (reason-flow) — удалить после диагностики
  const report = await reportsStore.getById(Number(reportId));
  if (!report) {
    console.warn('bot_reason_dbg report_not_found', { reportId }); // TEMP DEBUG (reason-flow) — удалить после диагностики
    return;
  }
  console.log('bot_reason_dbg report_found', { reportId, reportItemId: report.reportItemId, azsId: report.azsId, status: report.status }); // TEMP DEBUG (reason-flow) — удалить после диагностики
  const context = await backgroundContextForBot();
  const settings = await settingsStore.read({ context });
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
  console.log('bot_reason_dbg stage_resolved', { brakStatus, stagesRejected: settings?.report?.stages?.rejected || '', stagesExpired: settings?.report?.stages?.expired || '', entityTypeId, hasReasonField: Boolean(settings?.report?.fields?.reason) }); // TEMP DEBUG (reason-flow) — удалить после диагностики

  // 1) CRM: «браковать» карточку + записать причину одним обновлением, и зеркалить
  //    статус локально. Стадия меняется даже если UF-поле причины не настроено.
  try {
    const { buildReportCrmUpdateFields } = await import('./src/reports/reportCrmSync.js');
    const fields = buildReportCrmUpdateFields({
      settings,
      status: alreadyDone ? report.status : brakStatus,
      reasonValue
    });
    console.log('bot_reason_dbg crm_fields', { fieldKeys: Object.keys(fields), willUpdate: Boolean(entityTypeId && Number(report.reportItemId) && Object.keys(fields).length), reportItemId: report.reportItemId }); // TEMP DEBUG (reason-flow) — удалить после диагностики
    if (entityTypeId && Number(report.reportItemId) && Object.keys(fields).length) {
      await bitrixClient.updateReportItem({ entityTypeId, id: Number(report.reportItemId), fields, context });
      console.log('bot_reason_dbg crm_updated', { reportItemId: report.reportItemId }); // TEMP DEBUG (reason-flow) — удалить после диагностики
    } else {
      console.log('bot_reason_dbg crm_skipped', { entityTypeId, reportItemId: report.reportItemId, fieldCount: Object.keys(fields).length }); // TEMP DEBUG (reason-flow) — удалить после диагностики
    }
    if (!alreadyDone) {
      await reportsStore.setReportStatus({ reportId: Number(reportId), status: 'expired' })
        .then(() => { console.log('bot_reason_dbg local_status_set', { reportId }); }) // TEMP DEBUG (reason-flow) — удалить после диагностики
        .catch(() => { console.log('bot_reason_dbg local_status_failed', { reportId }); }); // TEMP DEBUG (reason-flow) — удалить после диагностики
    }
  } catch (crmError) {
    console.warn('bot_reason_crm_update_failed', { reportId, message: crmError.message, code: crmError.code, status: crmError.statusCode });
  }

  // 2) Forward to the responsible chat (best-effort)
  console.log('bot_reason_dbg forward_start', { reportItemId: report.reportItemId, portalDomain: String(context.domain || '') }); // TEMP DEBUG (reason-flow) — удалить после диагностики
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
    console.log('bot_reason_dbg forward_done', {}); // TEMP DEBUG (reason-flow) — удалить после диагностики
  } catch (fwdError) {
    console.warn('bot_reason_forward_failed', { reportId, message: fwdError.message, code: fwdError.code, status: fwdError.statusCode });
  }
  console.log('bot_reason_dbg flow_end', { reportId, brakStatus }); // TEMP DEBUG (reason-flow) — удалить после диагностики
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
const notificationService = createNotificationService({
  bitrixClient,
  resolveBotId: async (context = {}) => {
    const authId = String(context?.authId || context?.auth_id || '').trim();
    if (!authId) {
      return 0;
    }
    const registration = await botRegistryService.ensureBot({ authId, context });
    return registration.botId;
  },
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
    console.log('bot_reason_dbg gate', { decision, hasJobSecret: Boolean(process.env.JOB_SECRET), sParamPresent: req.query.s != null }); // TEMP DEBUG (reason-flow) — удалить после диагностики
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
    console.log('bot_reason_dbg event', { event, isMessageEvent, userId, dialogId, authorIsBot, textPreview: messageText.slice(0, 80) }); // TEMP DEBUG (reason-flow) — удалить после диагностики
    if (!isMessageEvent || !userId || authorIsBot) {
      const ignoredReason = !isMessageEvent ? 'not_message' : !userId ? 'no_user' : 'author_is_bot'; // TEMP DEBUG (reason-flow) — удалить после диагностики
      console.log('bot_reason_dbg ignored', { reason: ignoredReason }); // TEMP DEBUG (reason-flow) — удалить после диагностики
      return res.json({ ok: true, handled: false });
    }

    // Button press: "/reason <reportId>" (strict — a plain reason containing a
    // number must NOT be mistaken for the trigger).
    const reasonTrigger = messageText.match(/^\/reason\s+(\d+)\s*$/i);
    if (reasonTrigger) {
      const reportId = Number(reasonTrigger[1]);
      console.log('bot_reason_dbg trigger_reason', { reportId }); // TEMP DEBUG (reason-flow) — удалить после диагностики
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

    if (messageText) {
      // Plain message — captured as the reason only if this user is awaiting.
      console.log('bot_reason_dbg trigger_plain', {}); // TEMP DEBUG (reason-flow) — удалить после диагностики
      const handled = await botCommandHandler.handleMessage({ userId, dialogId, text: messageText, context });
      return res.json({ ok: true, handled, action: handled ? 'reason_captured' : 'ignored' });
    }

    console.log('bot_reason_dbg ignored', { reason: 'no_match' }); // TEMP DEBUG (reason-flow) — удалить после диагностики
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
        const placementStatus = await ensureRestAppUriPlacement({
          bitrixClient,
          authId,
          context: installContext,
          handlerUrl: resolveAppHandlerUrl()
        });
        payload.placement = {
          restAppUri: placementStatus.bound,
          alreadyExists: placementStatus.alreadyExists,
          handler: placementStatus.handler
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

reportsStore.ensurePhotoSchema()
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
  }
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

const tokenRefreshScheduler = createTokenRefreshScheduler({
  authContextStore,
  bitrixClient,
  enabled: String(process.env.TOKEN_REFRESH_SCHEDULER_ENABLED || 'true').toLowerCase() === 'true',
  cronExpression: process.env.TOKEN_REFRESH_CRON || '0 * * * *'
});

tokenRefreshScheduler.start();

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
