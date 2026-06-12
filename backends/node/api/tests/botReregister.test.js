/**
 * Tests for POST /api/admin/bot/reregister route handler logic
 * and botRegistryService force-registration branch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotRegistryService } from '../src/notifications/botRegistryService.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRes() {
  const state = { statusCode: 200, payload: null };
  return {
    state,
    status(code) { state.statusCode = code; return this; },
    json(payload) { state.payload = payload; return this; }
  };
}

/**
 * Build a minimal route handler that mirrors the server.js implementation for
 * POST /api/admin/bot/reregister.
 */
function buildReregisterHandler(botRegistryService) {
  return async (req, res) => {
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
  };
}

// ── Route tests ───────────────────────────────────────────────────────────────

test('POST /api/admin/bot/reregister returns 403 when capabilities.settings is false', async () => {
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth() { return { bot: { id: 1 } }; }
    },
    logger: { info() {}, warn() {} }
  });
  const handler = buildReregisterHandler(service);
  const req = {
    accessContext: { capabilities: { settings: false } },
    bitrixContext: { authId: 'token-abc' }
  };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.state.statusCode, 403);
  assert.equal(res.state.payload?.error, 'forbidden');
});

test('POST /api/admin/bot/reregister returns 403 when no capabilities', async () => {
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth() { return { bot: { id: 1 } }; }
    },
    logger: { info() {}, warn() {} }
  });
  const handler = buildReregisterHandler(service);
  const req = {
    accessContext: {},
    bitrixContext: { authId: 'token-abc' }
  };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.state.statusCode, 403);
});

test('POST /api/admin/bot/reregister returns 200 with botId on success', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method) {
        calls.push(method);
        if (method === 'imbot.v2.Bot.register') {
          return { bot: { id: 77 } };
        }
        return { bots: [] }; // empty list = no existing bot
      }
    },
    logger: { info() {}, warn() {} },
    botCode: 'azs_order_bot'
  });
  const handler = buildReregisterHandler(service);
  const req = {
    accessContext: { capabilities: { settings: true } },
    bitrixContext: { authId: 'token-admin' }
  };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.state.statusCode, 200);
  assert.equal(res.state.payload?.ok, true);
  assert.equal(res.state.payload?.botId, 77);
  assert.equal(res.state.payload?.registered, true);
  assert.equal(res.state.payload?.reused, false);
});

test('POST /api/admin/bot/reregister returns 502 on Bitrix error', async () => {
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method) {
        if (method === 'imbot.v2.Bot.register') {
          throw new Error('BITRIX_INTERNAL_ERROR: server error');
        }
        return { bots: [] };
      }
    },
    logger: { info() {}, warn() {} },
    botCode: 'azs_order_bot'
  });
  const handler = buildReregisterHandler(service);
  const req = {
    accessContext: { capabilities: { settings: true } },
    bitrixContext: { authId: 'token-admin' }
  };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.state.statusCode, 502);
  assert.equal(res.state.payload?.error, 'bot_reregister_failed');
  assert.ok(String(res.state.payload?.message).includes('BITRIX_INTERNAL_ERROR'));
});

test('POST /api/admin/bot/reregister returns 400 when auth_id_missing', async () => {
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth() { return { bot: { id: 1 } }; }
    },
    logger: { info() {}, warn() {} }
  });
  const handler = buildReregisterHandler(service);
  const req = {
    accessContext: { capabilities: { settings: true } },
    bitrixContext: { authId: '' } // empty authId
  };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.state.statusCode, 400);
  assert.equal(res.state.payload?.error, 'auth_id_missing');
});

// ── botRegistryService force=true branch ─────────────────────────────────────

test('ensureBot with force=true updates existing bot to webhook mode (register is a no-op for existing code)', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method) {
        calls.push(method);
        // imbot.v2.Bot.list — return existing bot; other methods return harmless ack
        return { bots: [{ id: 44, code: 'azs_order_bot', type: 'bot' }] };
      }
    },
    logger: { info() {}, warn() {} },
    botCode: 'azs_order_bot',
    handlerBaseUrl: 'https://app.example.com',
    jobSecret: 'sek'
  });

  const result = await service.ensureBot({ authId: 'token-x', force: true });
  assert.equal(result.registered, true);
  assert.equal(result.reused, false);
  assert.equal(result.botId, 44); // existing bot id, not a freshly-registered one
  // Bot.register is idempotent (no-op) for an existing code → must NOT be used;
  // webhook mode is re-applied via Bot.update instead.
  assert.ok(!calls.includes('imbot.v2.Bot.register'), 'register must NOT be called for existing bot');
  assert.ok(calls.includes('imbot.v2.Bot.update'), 'existing bot must be updated via Bot.update');
});

test('ensureBot with force=false (default) reuses existing bot without re-registering', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method) {
        calls.push(method);
        if (method === 'imbot.v2.Bot.list') {
          return { bots: [{ id: 44, code: 'azs_order_bot', type: 'bot' }] };
        }
        // imbot.v2.Bot.update for avatar
        return {};
      }
    },
    logger: { info() {}, warn() {} },
    botCode: 'azs_order_bot'
  });

  const result = await service.ensureBot({ authId: 'token-y' });
  assert.equal(result.reused, true);
  assert.equal(result.registered, false);
  assert.equal(result.botId, 44);
  // registerBot must NOT have been called
  assert.ok(!calls.includes('imbot.v2.Bot.register'), 'registerBot should NOT be called without force');
});

test('ensureBot force=true logs force-reregister and updates the existing bot', async () => {
  const logMessages = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method) {
        return { bots: [{ id: 88, code: 'azs_order_bot', type: 'bot' }] };
      }
    },
    logger: {
      info(msg, ctx) { logMessages.push({ msg, ctx }); },
      warn() {}
    },
    botCode: 'azs_order_bot',
    handlerBaseUrl: 'https://app.example.com',
    jobSecret: 'sek'
  });

  const res = await service.ensureBot({ authId: 'token-z', force: true });
  assert.equal(res.botId, 88);
  const forceLog = logMessages.find(l => String(l.msg).includes('force-reregister'));
  assert.ok(forceLog, 'force-reregister should be logged');
  assert.equal(forceLog.ctx.botId, 88);
});
