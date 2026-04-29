import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import verifyToken from './utils/verifyToken.js';
import createSettingsRouter from './src/settings/settingsRoutes.js';
import { createFileSettingsStore } from './src/settings/fileSettingsStore.js';
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

const settingsStore = createFileSettingsStore();
const dispatchLogStore = createDispatchLogStore({ pool, dbType });
const reportsStore = createReportsStore({ pool, dbType });
const bitrixClient = createBitrixRestClient();
const notificationService = createNotificationService({ bitrixClient });
const botRegistryService = createBotRegistryService({ bitrixClient });
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

app.get('/', (req, res) => {
  res.json([
    '!default route for index page, please use /api/* routes'
  ]);
});

app.get('/api/health', verifyToken, (req, res) => {
  res.json({
    status: 'healthy',
    backend: 'node',
    timestamp: Math.floor(Date.now() / 1000)
  });
});

app.use('/api/settings', verifyToken, createSettingsRouter({ store: settingsStore }));
app.use('/api/jobs', verifyToken, createDispatchRouter({ dispatchService }));
app.use('/api/reports', verifyToken, createReportsRouter({
  reportsStore,
  dispatchService,
  settingsStore,
  bitrixClient,
  notificationService
}));

app.post('/api/install', async (req, res) => {
  console.log('/api/install', req.body);
  const botMode = String(process.env.BITRIX_BOT_MODE || 'notify').trim().toLowerCase();
  const authId = String(req.body?.AUTH_ID || '').trim();

  const payload = {
    message: 'All success',
    bot: {
      mode: botMode,
      registered: false,
      botId: Number(process.env.BITRIX_BOT_ID || 0) || null
    }
  };

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
    const registration = await botRegistryService.registerBot({ authId });
    process.env.BITRIX_BOT_ID = String(registration.botId);
    if (typeof notificationService.setBotId === 'function') {
      notificationService.setBotId(registration.botId);
    }
    const bots = await botRegistryService.listBots({ authId }).catch(() => []);
    return res.json({
      ...payload,
      bot: {
        mode: botMode,
        registered: true,
        botId: registration.botId,
        bots
      }
    });
  } catch (error) {
    return res.status(502).json({
      error: 'bot_register_failed',
      message: error.message,
      bot: payload.bot
    });
  }
});

app.post('/api/getToken', async (req, res) => {
  console.log('/api/getToken', req.body);
  const userId = Number(req.body?.user_id || 0) || 0;
  const appInfo = {
    id: userId,
    user_id: userId
  };

  const token = jwt.sign(appInfo, process.env.JWT_SECRET, { expiresIn: '1h' });

  res.json({
    token: token
  });
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
  timeoutWatcher,
  enabled: String(process.env.SCHEDULER_ENABLED || 'false').toLowerCase() === 'true',
  cronExpression: process.env.DISPATCH_CRON || '*/5 * * * *',
  timeoutCronExpression: process.env.TIMEOUT_CRON || '*/5 * * * *'
});

scheduler.start().catch((error) => {
  console.error('Failed to start scheduler', error);
});
