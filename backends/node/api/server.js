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
import { readDispatchCandidates } from './src/dispatch/dispatchCandidatesFileStore.js';
import createReportsStore from './src/reports/reportsStore.js';
import createReportsRouter from './src/reports/reportsRoutes.js';

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
const dispatchService = createDispatchService({
  dispatchLogStore,
  settingsStore,
  bitrixClient
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

app.get('/api/enum', verifyToken, async (req, res) => {
  res.json([
    'option 1',
    'option 2',
    'option 3'
  ]);
});

app.get('/api/list', verifyToken, async (req, res) => {
  res.json([
    'element 1',
    'element 2',
    'element 3'
  ]);
});

app.use('/api/settings', verifyToken, createSettingsRouter({ store: settingsStore }));
app.use('/api/jobs', verifyToken, createDispatchRouter({ dispatchService }));
app.use('/api/reports', verifyToken, createReportsRouter({ reportsStore, dispatchService }));

app.post('/api/install', async (req, res) => {
  console.log('/api/install', req.body);
  res.json({
    message: 'All success'
  });
});

app.post('/api/getToken', async (req, res) => {
  console.log('/api/getToken', req.body);
  const appInfo = {
    id: 1
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

const scheduler = createDispatchScheduler({
  dispatchService,
  getCandidates: () => readDispatchCandidates(),
  enabled: String(process.env.SCHEDULER_ENABLED || 'false').toLowerCase() === 'true',
  cronExpression: process.env.DISPATCH_CRON || '*/5 * * * *'
});

scheduler.start().catch((error) => {
  console.error('Failed to start scheduler', error);
});
