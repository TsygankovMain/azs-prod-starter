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
import createReportsRouter from './src/reports/reportsRoutes.js';
import createNotificationService from './src/notifications/notificationService.js';
import createBotRegistryService from './src/notifications/botRegistryService.js';
import { createAuthContextStore } from './src/auth/authContextStore.js';
import { createTokenRefreshScheduler } from './src/auth/tokenRefreshScheduler.js';
import { resolveAccessContext } from './src/access/roleResolver.js';

const app = express();
app.use(cors());
app.use(express.json());

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
    password: process.env.DB_PASSWORD || 'apppass'
  });

const parseUserId = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const parseBoolean = (value) => {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'y' || raw === 'yes' || raw === 'true';
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
const dbSettingsStore = createDatabaseSettingsStore({ pool, dbType });
const authContextStore = createAuthContextStore();
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
const bitrixSettingsStore = createBitrixAppSettingsStore({
  bitrixClient,
  optionKey: process.env.BITRIX_APP_SETTINGS_OPTION_KEY || 'azs_photo_report_settings_v1'
});
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
  }
});
const timeoutWatcher = createTimeoutWatcher({
  reportsStore,
  bitrixClient,
  settingsStore,
  notificationService
});
const dispatchService = createDispatchService({
  dispatchLogStore,
  settingsStore,
  bitrixClient,
  notificationService,
  timeoutWatcher
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

// Public liveness/readiness probe for platform health checks.
// Keep this endpoint auth-free and keep /api/health protected.
app.get('/api/healthz', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    backend: 'node',
    timestamp: Math.floor(Date.now() / 1000)
  });
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

app.use('/api/settings', verifyToken, attachAccessContext, createSettingsRouter({ store: settingsStore }));
app.use('/api/jobs', verifyToken, attachAccessContext, createDispatchRouter({ dispatchService }));
app.use('/api/reports', verifyToken, attachAccessContext, createReportsRouter({
  reportsStore,
  dispatchService,
  settingsStore,
  bitrixClient,
  notificationService,
  authContextStore
}));

app.post('/api/install', async (req, res) => {
  try {
    console.log('/api/install', req.body);
    const botMode = String(process.env.BITRIX_BOT_MODE || 'notify').trim().toLowerCase();
    const authId = String(req.body?.AUTH_ID || '').trim();
    const refreshToken = String(req.body?.REFRESH_TOKEN || req.body?.REFRESH_ID || '').trim();
    const domain = String(req.body?.DOMAIN || '').trim().toLowerCase();
    const memberId = String(req.body?.member_id || '').trim();
    const userId = parseUserId(req.body?.user_id);
    const appSid = String(req.body?.APP_SID || '').trim();

    const installContext = buildInstallContext({
      authId,
      refreshToken,
      domain,
      memberId,
      userId,
      appSid
    });

    if (authId || refreshToken || domain || memberId || userId) {
      await authContextStore.upsertContext({
        ...installContext,
        isAdmin: true,
        // Stamp issuance time so tokenRefreshScheduler can detect the
        // ~30-day Bitrix refresh_token TTL and warn before silent death.
        refreshTokenIssuedAt: new Date().toISOString()
      }).catch((error) => {
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
    console.log('/api/getToken', req.body);
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
    const profileAdminRaw = profile?.ADMIN;
    const requestAdminRaw = pickFirstDefined(
      req.body?.is_admin,
      req.body?.IS_ADMIN,
      req.body?.admin,
      req.body?.ADMIN
    );
    const previousContext = await authContextStore.getContext(contextDraft) || {};
    const isAdmin = (profileAdminRaw === undefined || profileAdminRaw === null || profileAdminRaw === '')
      ? (
          requestAdminRaw === undefined
            ? Boolean(previousContext.isAdmin)
            : parseBoolean(requestAdminRaw)
        )
      : parseBoolean(profileAdminRaw);
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
app.listen(PORT, () => {
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
  timeoutCronExpression: process.env.TIMEOUT_CRON || '*/5 * * * *'
});

scheduler.start().catch((error) => {
  console.error('Failed to start scheduler', error);
});

const tokenRefreshScheduler = createTokenRefreshScheduler({
  authContextStore,
  bitrixClient,
  enabled: String(process.env.TOKEN_REFRESH_SCHEDULER_ENABLED || 'true').toLowerCase() === 'true',
  cronExpression: process.env.TOKEN_REFRESH_CRON || '0 * * * *'
});

tokenRefreshScheduler.start();
