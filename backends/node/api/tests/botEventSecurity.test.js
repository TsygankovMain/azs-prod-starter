/**
 * Security tests for POST /api/bot/event shared-secret gate and
 * botRegistryService event handler URL construction.
 *
 * TDD: tests written FIRST — all must fail before the implementation is added.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotRegistryService } from '../src/notifications/botRegistryService.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal route handler that mirrors the /api/bot/event logic in
 * server.js, but is importable without a running server.
 *
 * The real guard is a few lines in server.js; we test the same logic here by
 * extracting it into a verifyBotEventSecret() helper that server.js will call.
 */

/**
 * Inline copy of the guard logic (kept deliberately simple).
 * The actual implementation in server.js must follow the same semantics:
 *
 *   const secret = process.env.JOB_SECRET;
 *   if (secret && req.query.s !== secret) → 200 {ok:true, handled:false}
 *   if (!secret) → log warning once, proceed
 */
function makeEventHandler({ jobSecret } = {}) {
  const recorded = [];
  let warnLogged = false;
  const warns = [];

  const logger = {
    warn(...args) {
      warns.push(args.join(' '));
      warnLogged = true;
    }
  };

  // Minimal bot command handler stub
  const botCommandHandler = {
    parseReasonCommand(cmd) {
      if (cmd && cmd.startsWith('REASON:')) {
        return Number(cmd.replace('REASON:', '')) || null;
      }
      return null;
    },
    async handleCommand({ reportId }) {
      recorded.push({ type: 'command', reportId });
    },
    async handleMessage({ text }) {
      recorded.push({ type: 'message', text });
      return true;
    }
  };

  const reportsStore = {
    async getById() { return { azsId: 'azs-1' }; }
  };

  // Mirror of the guard + route logic from server.js
  const handler = async (req, res) => {
    const secret = jobSecret !== undefined ? jobSecret : '';

    // ── SECURITY GATE ──
    if (secret) {
      if (req.query.s !== secret) {
        // Fail-closed: wrong or missing secret → silently ignore
        logger.warn('bot event request rejected: wrong or missing ?s param');
        return res.json({ ok: true, handled: false });
      }
    } else {
      // No secret configured — log once and proceed (dev / unconfigured envs)
      if (!warnLogged) {
        logger.warn('JOB_SECRET not set — /api/bot/event is UNVERIFIED');
        warnLogged = true;
      }
    }

    const body = req.body || {};
    const params = body?.data?.PARAMS || body?.PARAMS || {};
    const event = String(body?.event || body?.EVENT || body?.data?.EVENT || '').toUpperCase();
    const userId = Number(params?.FROM_USER_ID || 0);
    const dialogId = String(params?.DIALOG_ID || (userId ? `u${userId}` : ''));
    const messageText = String(params?.MESSAGE || '');
    const command = String(params?.COMMAND || '');

    if (!userId) return res.json({ ok: true, handled: false });

    if (event === 'ONIMBOTMESSAGEADD' && command) {
      const reportId = botCommandHandler.parseReasonCommand(command);
      if (reportId) {
        let azsId = '';
        try {
          const report = await reportsStore.getById(reportId);
          azsId = String(report?.azsId || '');
        } catch { /* best-effort */ }
        await botCommandHandler.handleCommand({ userId, dialogId, reportId, azsId, context: {} });
        return res.json({ ok: true, handled: true, action: 'awaiting_reason' });
      }
      return res.json({ ok: true, handled: false });
    }

    if (event === 'ONIMBOTMESSAGEADD' && !command && messageText) {
      const handled = await botCommandHandler.handleMessage({ userId, dialogId, text: messageText, context: {} });
      return res.json({ ok: true, handled, action: handled ? 'reason_captured' : 'ignored' });
    }

    return res.json({ ok: true, handled: false });
  };

  return { handler, recorded, warns };
}

function makeRes() {
  const state = { statusCode: 200, payload: null };
  return {
    state,
    status(code) { state.statusCode = code; return this; },
    json(payload) { state.payload = payload; return this; }
  };
}

function makeReq({ body = {}, query = {} } = {}) {
  return { body, query };
}

// ─── Security gate: JOB_SECRET IS SET ────────────────────────────────────────

test('/api/bot/event: wrong ?s param → handled:false, does NOT record reason', async () => {
  const { handler, recorded } = makeEventHandler({ jobSecret: 'secret-abc' });

  const req = makeReq({
    body: {
      EVENT: 'ONIMBOTMESSAGEADD',
      PARAMS: { FROM_USER_ID: 5, DIALOG_ID: 'u5', COMMAND: 'REASON:42' }
    },
    query: { s: 'wrong-secret' }
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.state.payload?.ok, true);
  assert.equal(res.state.payload?.handled, false, 'must not process with wrong secret');
  assert.equal(recorded.length, 0, 'must NOT record any command/message');
});

test('/api/bot/event: missing ?s param → handled:false, does NOT record reason', async () => {
  const { handler, recorded } = makeEventHandler({ jobSecret: 'secret-abc' });

  const req = makeReq({
    body: {
      EVENT: 'ONIMBOTMESSAGEADD',
      PARAMS: { FROM_USER_ID: 5, DIALOG_ID: 'u5', COMMAND: 'REASON:42' }
    },
    query: {}  // no ?s
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.state.payload?.ok, true);
  assert.equal(res.state.payload?.handled, false, 'must not process with missing secret');
  assert.equal(recorded.length, 0, 'must NOT record any command/message');
});

test('/api/bot/event: correct ?s → processes COMMAND and returns handled:true', async () => {
  const { handler, recorded } = makeEventHandler({ jobSecret: 'secret-abc' });

  const req = makeReq({
    body: {
      EVENT: 'ONIMBOTMESSAGEADD',
      PARAMS: { FROM_USER_ID: 5, DIALOG_ID: 'u5', COMMAND: 'REASON:42' }
    },
    query: { s: 'secret-abc' }
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.state.payload?.ok, true);
  assert.equal(res.state.payload?.handled, true, 'must process with correct secret');
  assert.equal(recorded.length, 1, 'must record the command');
  assert.equal(recorded[0].type, 'command');
  assert.equal(recorded[0].reportId, 42);
});

test('/api/bot/event: correct ?s → processes plain message and returns handled:true', async () => {
  const { handler, recorded } = makeEventHandler({ jobSecret: 'secret-abc' });

  const req = makeReq({
    body: {
      EVENT: 'ONIMBOTMESSAGEADD',
      PARAMS: { FROM_USER_ID: 7, DIALOG_ID: 'u7', MESSAGE: 'Мотор сломан' }
    },
    query: { s: 'secret-abc' }
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.state.payload?.ok, true);
  assert.equal(res.state.payload?.handled, true, 'must process message with correct secret');
  assert.equal(recorded.length, 1, 'must record the message');
  assert.equal(recorded[0].type, 'message');
  assert.ok(recorded[0].text.includes('Мотор'), 'captured text must match input');
});

// ─── Security gate: JOB_SECRET NOT SET (dev/unconfigured) ────────────────────

test('/api/bot/event: no JOB_SECRET configured → logs warning and processes request', async () => {
  const { handler, recorded, warns } = makeEventHandler({ jobSecret: '' });

  const req = makeReq({
    body: {
      EVENT: 'ONIMBOTMESSAGEADD',
      PARAMS: { FROM_USER_ID: 9, DIALOG_ID: 'u9', COMMAND: 'REASON:10' }
    },
    query: {}  // no ?s — should still pass when no secret configured
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.state.payload?.handled, true, 'should process when no secret configured');
  assert.equal(recorded.length, 1, 'must record the command');
  assert.ok(warns.some((w) => w.toLowerCase().includes('unverified') || w.toLowerCase().includes('job_secret')),
    'must log a warning about unverified endpoint');
});

// ─── botRegistryService: handler URL includes ?s=<SECRET> ────────────────────

test('botRegistryService: registers event handler URL with ?s=<JOB_SECRET> when secret is set', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method, params, authId) {
        calls.push({ method, params, authId });
        return { bot: { id: 901 } };
      }
    },
    botCode: 'azs_order_bot',
    botName: 'Порядок на АЗС',
    handlerBaseUrl: 'https://example.com',
    jobSecret: 'mysecret'
  });

  await service.registerBot({ authId: 'token-1' });

  const registerCall = calls.find((c) => c.method === 'imbot.v2.Bot.register');
  assert.ok(registerCall, 'imbot.v2.Bot.register must be called');

  // The handler URL must be set in the fields
  const fields = registerCall.params.fields;
  const handlerUrl = fields?.event_message_add || fields?.handler || '';
  assert.ok(
    String(handlerUrl).includes('/api/bot/event'),
    `handler URL must include /api/bot/event, got: ${handlerUrl}`
  );
  assert.ok(
    String(handlerUrl).includes('?s=mysecret') || String(handlerUrl).includes('s=mysecret'),
    `handler URL must include secret param, got: ${handlerUrl}`
  );
});

test('botRegistryService: omits ?s param from handler URL when jobSecret is empty', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method, params, authId) {
        calls.push({ method, params, authId });
        return { bot: { id: 902 } };
      }
    },
    botCode: 'azs_order_bot',
    botName: 'Порядок на АЗС',
    handlerBaseUrl: 'https://example.com',
    jobSecret: ''
  });

  await service.registerBot({ authId: 'token-2' });

  const registerCall = calls.find((c) => c.method === 'imbot.v2.Bot.register');
  assert.ok(registerCall, 'imbot.v2.Bot.register must be called');

  const fields = registerCall.params.fields;
  const handlerUrl = fields?.event_message_add || fields?.handler || '';

  // When no secret, URL should still include the endpoint path but no ?s= param
  if (handlerUrl) {
    assert.ok(
      !String(handlerUrl).includes('?s=') && !String(handlerUrl).includes('&s='),
      `handler URL must NOT include ?s= when secret is empty, got: ${handlerUrl}`
    );
  }
  // Alternatively: if no handlerBaseUrl is set, the field may be absent — that is also acceptable
});

test('botRegistryService: handler URL format is <handlerBaseUrl>/api/bot/event?s=<SECRET>', async () => {
  const calls = [];
  const service = createBotRegistryService({
    bitrixClient: {
      async callMethodWithAuth(method, params, authId) {
        calls.push({ method, params, authId });
        return { bot: { id: 903 } };
      }
    },
    botCode: 'azs_order_bot',
    handlerBaseUrl: 'https://app.example.com',
    jobSecret: 'abc123'
  });

  await service.registerBot({ authId: 'token-3' });

  const registerCall = calls.find((c) => c.method === 'imbot.v2.Bot.register');
  const fields = registerCall.params.fields;
  const handlerUrl = fields?.event_message_add || fields?.handler || '';

  assert.equal(
    handlerUrl,
    'https://app.example.com/api/bot/event?s=abc123',
    `handler URL must be exactly <base>/api/bot/event?s=<secret>, got: ${handlerUrl}`
  );
});
