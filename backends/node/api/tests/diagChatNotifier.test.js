import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagChatNotifier, buildCardText } from '../src/diag/diagChatNotifier.js';

const silentLogger = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// Fixtures — shapes match frontend/app/utils/diag/types.ts (bundle) and
// src/diag/serverSelfCheck.js (serverSlice), trimmed to what the card reads.
// ---------------------------------------------------------------------------

const makeBundle = (overrides = {}) => ({
  v: 1,
  diagSessionId: 'sess-1',
  sentAt: '2026-07-30T10:15:00.000Z',
  trigger: 'button',
  app: { build: 'x', route: '/reason', isDemo: false },
  user: { userId: 498, azsId: '548', reportId: 12345, role: 'azs_admin' },
  device: { userAgent: 'ua', deviceMemory: null, hardwareConcurrency: null, screen: { w: 1, h: 1, dpr: 1 }, language: 'ru', platform: 'x' },
  network: { onLine: true, effectiveType: '4g', downlink: 5, rtt: 80, saveData: false },
  probe: { echoBytes: 307200, echoMs: 2000, echoKbps: 1200, pingMsMedian: 45, pingLoss: 0 },
  startup: { navigationMs: null, ttfbMs: null, domContentLoadedMs: null, resourceCount: 0 },
  queue: { activeCount: 0, maxConcurrency: 2, workerSessionId: 1, slots: [] },
  uploads: [],
  net: [],
  errors: [],
  b24: [],
  dropped: { net: 0, errors: 0, uploads: 0 },
  ...overrides
});

const makeServerSlice = (overrides = {}) => ({
  checkedAt: '2026-07-30T10:15:01.000Z',
  app: { botMode: 'bot', nodeEnv: 'production', schedulerEnabled: true },
  oauth: {
    hasContext: true, domain: 'portal.bitrix24.ru', memberId: 'member-1', updatedAt: null, ageSec: 7,
    hasAuthId: true, hasRefreshToken: true, authIdLength: 32, refreshTokenLength: 40, clientConfigured: true
  },
  disk: { ok: true, ms: 120, errorCode: null, errorMessage: null },
  db: { ok: true, ms: 3, errorMessage: null },
  ...overrides
});

const CONTEXT_MARKER = { authId: 'resolved-admin-context', domain: 'p.bitrix24.ru' };

const makeBitrixClient = ({ uploadImpl = null, sendImpl = null } = {}) => {
  const calls = [];
  return {
    calls,
    async callMethod(method, params, context) {
      calls.push({ method, params, context });
      if (method === 'imbot.v2.File.upload') {
        if (uploadImpl) return uploadImpl(params, context);
        return { id: 1 };
      }
      if (method === 'imbot.v2.Chat.Message.send') {
        if (sendImpl) return sendImpl(params, context);
        return { id: 2 };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };
};

const makeNotifier = (overrides = {}) => {
  const bitrixClient = overrides.bitrixClient ?? makeBitrixClient();
  return createDiagChatNotifier({
    bitrixClient,
    // Task 12 fix round: botId is no longer a constructor argument — the bot
    // registers itself, so its id is only knowable at call time, under a
    // resolved auth context (see diagChatNotifier.js header + server.js
    // resolveBotIdViaRegistry). Default fake mirrors that: an async function,
    // not a static number.
    resolveBotId: overrides.resolveBotId ?? (async () => 77),
    dialogId: overrides.dialogId ?? 'chat22574',
    resolveContext: overrides.resolveContext ?? (async () => CONTEXT_MARKER),
    logger: overrides.logger ?? silentLogger
  });
};

// ---------------------------------------------------------------------------
// imbot.v2.File.upload — happy path
// ---------------------------------------------------------------------------

test('notify: uploads file with correct dialogId, filename with the code, and base64 content decoding back to the bundle', async () => {
  const bitrixClient = makeBitrixClient();
  const notifier = makeNotifier({ bitrixClient });
  const bundle = makeBundle();
  const serverSlice = makeServerSlice();

  const result = await notifier.notify({ code: 'A7F3QQ', bundle, serverSlice });

  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.equal(result.channel, 'file');
  assert.equal(bitrixClient.calls.length, 1);

  const call = bitrixClient.calls[0];
  assert.equal(call.method, 'imbot.v2.File.upload');
  // botId comes from the fake resolveBotId (an async function), never a
  // static constructor value — see makeNotifier() and the dedicated
  // resolveBotId tests below.
  assert.equal(call.params.botId, 77);
  assert.equal(call.params.dialogId, 'chat22574', 'dialogId must be the string chat22574, not a number');
  assert.match(call.params.fields.name, /A7F3QQ/, 'filename must contain the diagnostic code');
  assert.ok(call.params.fields.message, 'card text must be attached as the message');

  const decoded = JSON.parse(Buffer.from(call.params.fields.content, 'base64').toString('utf8'));
  assert.deepEqual(decoded.bundle, bundle, 'base64 content must decode back to the exact stored bundle');
  assert.deepEqual(decoded.serverSlice, serverSlice);

  // Auth context: reused mechanism, never an empty {} (see server.js wiring).
  assert.deepEqual(call.context, CONTEXT_MARKER);
});

test('notify: card text contains the АЗС id, the diagnostic code, and the channel measurement', async () => {
  const bitrixClient = makeBitrixClient();
  const notifier = makeNotifier({ bitrixClient });
  const bundle = makeBundle({ user: { userId: 1, azsId: '548-СЕВЕР', reportId: 1, role: 'x' } });

  await notifier.notify({ code: 'B9K2ZZ', bundle, serverSlice: makeServerSlice() });

  const cardText = bitrixClient.calls[0].params.fields.message;
  assert.match(cardText, /548-СЕВЕР/, 'card must mention the AZS');
  assert.match(cardText, /B9K2ZZ/, 'card must mention the diagnostic code');
  // Channel measurement: echoKbps=1200 rounded, present as a number in the card.
  assert.match(cardText, /1200/, 'card must mention the echo channel measurement');
});

test('buildCardText: trigger wording distinguishes operator button press from an automatic upload failure', () => {
  const buttonText = buildCardText({ code: 'X', bundle: makeBundle({ trigger: 'button' }), serverSlice: null });
  const autoText = buildCardText({ code: 'X', bundle: makeBundle({ trigger: 'auto_upload_error' }), serverSlice: null });
  assert.notEqual(buttonText, autoText);
  assert.match(buttonText, /оператор/i);
  assert.match(autoText, /автомат/i);
});

test('buildCardText: includes ping when present', () => {
  const withPing = buildCardText({
    code: 'X',
    bundle: makeBundle({ probe: { echoBytes: 1, echoMs: 1, echoKbps: 1, pingMsMedian: 45, pingLoss: 10 } }),
    serverSlice: null
  });
  assert.match(withPing, /45 мс/);
  assert.match(withPing, /10%/);
});

test('buildCardText: omits the ping line entirely when pingMsMedian is null', () => {
  const withoutPing = buildCardText({
    code: 'X',
    bundle: makeBundle({ probe: { echoBytes: 1, echoMs: 1, echoKbps: 1, pingMsMedian: null, pingLoss: null } }),
    serverSlice: null
  });
  assert.doesNotMatch(withoutPing, /Пинг:/);
});

test('buildCardText: reports our own side health — disk ok/errorCode and OAuth context presence', () => {
  const healthy = buildCardText({ code: 'X', bundle: makeBundle(), serverSlice: makeServerSlice() });
  assert.match(healthy, /Диск Битрикса: OK/);
  assert.match(healthy, /OAuth-контекст: есть/);

  const broken = buildCardText({
    code: 'X',
    bundle: makeBundle(),
    serverSlice: makeServerSlice({
      disk: { ok: false, ms: 5000, errorCode: 'wrong_client', errorMessage: 'boom' },
      oauth: { ...makeServerSlice().oauth, hasContext: false }
    })
  });
  assert.match(broken, /Диск Битрикса: ошибка \(wrong_client\)/);
  assert.match(broken, /OAuth-контекст: отсутствует/);
});

test('buildCardText: counts errors and failed uploads without dumping raw entries', () => {
  const bundle = makeBundle({
    errors: [{ kind: 'onerror', message: 'x', at: '' }, { kind: 'console', message: 'y', at: '' }],
    uploads: [
      { photoCode: 'a', outcome: 'ok' },
      { photoCode: 'b', outcome: 'error' },
      { photoCode: 'c', outcome: 'error' }
    ]
  });
  const text = buildCardText({ code: 'X', bundle, serverSlice: null });
  assert.match(text, /Ошибок в логе: 2/);
  assert.match(text, /Неудачных загрузок: 2 из 3/);
});

test('buildCardText: does not phrase the channel measurement as a verdict about the operator', () => {
  const text = buildCardText({ code: 'X', bundle: makeBundle(), serverSlice: null });
  // Только числа/факты, никаких обвинительных формулировок оператора.
  assert.doesNotMatch(text, /виноват/i);
  assert.doesNotMatch(text, /плохо/i);
  assert.doesNotMatch(text, /оператора медленн/i);
});

// ---------------------------------------------------------------------------
// Fallback to imbot.v2.Chat.Message.send
// ---------------------------------------------------------------------------

test('notify: falls back to imbot.v2.Chat.Message.send when file upload rejects, and says the attachment failed', async () => {
  const bitrixClient = makeBitrixClient({
    uploadImpl: () => { throw new Error('DISK_ERROR'); }
  });
  const notifier = makeNotifier({ bitrixClient });
  const bundle = makeBundle();

  const result = await notifier.notify({ code: 'C4M1XX', bundle, serverSlice: makeServerSlice() });

  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.equal(result.channel, 'text_fallback');
  assert.equal(bitrixClient.calls.length, 2, 'upload attempted first, then fallback');
  assert.equal(bitrixClient.calls[0].method, 'imbot.v2.File.upload');

  const fallbackCall = bitrixClient.calls[1];
  assert.equal(fallbackCall.method, 'imbot.v2.Chat.Message.send');
  assert.equal(fallbackCall.params.dialogId, 'chat22574');
  assert.deepEqual(fallbackCall.context, CONTEXT_MARKER);
  assert.match(fallbackCall.params.fields.message, /не удалось/i, 'fallback message must say the attachment failed');
  assert.match(fallbackCall.params.fields.message, /C4M1XX/, 'fallback message must include the code so the bundle can be pulled from the DB');
});

test('notify: both imbot.v2.File.upload and imbot.v2.Chat.Message.send rejecting resolves, not throws', async () => {
  const errors = [];
  const bitrixClient = makeBitrixClient({
    uploadImpl: () => { throw new Error('upload down'); },
    sendImpl: () => { throw new Error('send down too'); }
  });
  const notifier = makeNotifier({
    bitrixClient,
    logger: { info() {}, warn() {}, error: (...args) => errors.push(args) }
  });

  await assert.doesNotReject(() => notifier.notify({ code: 'D0G0NE', bundle: makeBundle(), serverSlice: null }));
  const result = await notifier.notify({ code: 'D0G0NE', bundle: makeBundle(), serverSlice: null });

  assert.equal(result.ok, false);
  assert.equal(result.delivered, false);
  assert.ok(errors.length > 0, 'total failure must still be logged');
});

// ---------------------------------------------------------------------------
// Disabled configuration
// ---------------------------------------------------------------------------

test('notify: empty dialogId → disabled, nothing is called at all', async () => {
  const bitrixClient = makeBitrixClient();
  const notifier = makeNotifier({ bitrixClient, dialogId: '' });

  const result = await notifier.notify({ code: 'E5N0PE', bundle: makeBundle(), serverSlice: null });

  assert.equal(result.disabled, true);
  assert.equal(result.delivered, false);
  assert.equal(bitrixClient.calls.length, 0, 'no Bitrix call of any kind when disabled');
});

// Task 12 fix round: this used to be "notify: missing botId → disabled,
// nothing is called at all", constructed with `botId: 0`. botId is no longer
// a constructor argument at all — the bot registers itself, so its id isn't
// knowable until call time (see diagChatNotifier.js header). The equivalent
// scenario now is resolveBotId() resolving to 0 at call time, which is a
// DIFFERENT situation from "disabled" (dialogId empty) and must not be
// conflated with it — see the three tests below, replacing this one.

test('notify: resolveBotId() resolving to 0 → no Bitrix call at all, non-throwing, diag_chat_no_bot logged (not "disabled")', async () => {
  const bitrixClient = makeBitrixClient();
  const events = [];
  const notifier = makeNotifier({
    bitrixClient,
    resolveBotId: async () => 0,
    logger: { info() {}, warn: (event, meta) => events.push({ event, meta }), error() {} }
  });

  const result = await notifier.notify({ code: 'F6O1KE', bundle: makeBundle(), serverSlice: null });

  assert.equal(bitrixClient.calls.length, 0, 'no Bitrix call of any kind when the bot id could not be resolved');
  assert.equal(result.ok, false);
  assert.equal(result.delivered, false);
  // Must NOT be reported as "disabled" — DIAG_CHAT_ID is set, the owner
  // wants delivery; the bot just isn't registered/resolvable. Different fact.
  assert.notEqual(result.disabled, true, 'a resolvable-but-zero bot id is not the same situation as "not configured"');
  assert.equal(result.reason, 'no_bot_id');
  assert.ok(events.some((e) => e.event === 'diag_chat_no_bot'), 'must log the distinct diag_chat_no_bot event');
});

test('notify: resolveBotId() returning a real id → posts using exactly that id as botId', async () => {
  const bitrixClient = makeBitrixClient();
  const notifier = makeNotifier({ bitrixClient, resolveBotId: async () => 4242 });

  const result = await notifier.notify({ code: 'H8Q3ME', bundle: makeBundle(), serverSlice: null });

  assert.equal(result.ok, true);
  assert.equal(bitrixClient.calls.length, 1);
  assert.equal(bitrixClient.calls[0].params.botId, 4242);
});

test('notify: resolveBotId() throwing → notify() still resolves, nothing escapes, no Bitrix call is attempted', async () => {
  const bitrixClient = makeBitrixClient();
  const events = [];
  const notifier = makeNotifier({
    bitrixClient,
    resolveBotId: async () => { throw new Error('botRegistryService: registration blew up'); },
    logger: { info() {}, warn: (event, meta) => events.push({ event, meta }), error() {} }
  });

  await assert.doesNotReject(() => notifier.notify({ code: 'J1R4EE', bundle: makeBundle(), serverSlice: null }));
  const result = await notifier.notify({ code: 'J1R4EE', bundle: makeBundle(), serverSlice: null });

  assert.equal(result.ok, false);
  assert.equal(result.delivered, false);
  assert.equal(bitrixClient.calls.length, 0, 'a throwing resolveBotId must never reach bitrixClient.callMethod');
  assert.ok(events.some((e) => e.event === 'diag_chat_no_bot'), 'still ends up in the same "no bot" outcome, logged');
});

test('notify: resolveBotId() is called with the resolved auth context, not {} — same class of bug already fixed in the Disk probe', async () => {
  const bitrixClient = makeBitrixClient();
  const receivedContexts = [];
  const notifier = makeNotifier({
    bitrixClient,
    resolveContext: async () => CONTEXT_MARKER,
    resolveBotId: async (context) => { receivedContexts.push(context); return 99; }
  });

  await notifier.notify({ code: 'K2S5PP', bundle: makeBundle(), serverSlice: null });

  assert.equal(receivedContexts.length, 1);
  assert.deepEqual(receivedContexts[0], CONTEXT_MARKER, 'resolveBotId must receive the real resolved context, never an empty {}');
  assert.notDeepEqual(receivedContexts[0], {}, 'sanity: must not be the empty-context bug repeated for bot id resolution');
});

// ---------------------------------------------------------------------------
// No sensitive leakage beyond what the (already-redacted) bundle carries
// ---------------------------------------------------------------------------

test('notify: card text does not leak OAuth/token details beyond presence — file still carries the full stored bundle', async () => {
  const bitrixClient = makeBitrixClient();
  const notifier = makeNotifier({ bitrixClient });
  const bundle = makeBundle();
  const serverSlice = makeServerSlice({
    oauth: {
      hasContext: true,
      domain: 'super-secret-portal.bitrix24.ru',
      memberId: 'MEMBER-SECRET-ID',
      updatedAt: null,
      ageSec: 7,
      hasAuthId: true,
      hasRefreshToken: true,
      authIdLength: 555,
      refreshTokenLength: 777,
      clientConfigured: true
    },
    disk: { ok: false, ms: 10, errorCode: 'wrong_client', errorMessage: 'leaked client_secret=ABCDEF123456 in message' }
  });

  await notifier.notify({ code: 'G7P2LE', bundle, serverSlice });

  const cardText = bitrixClient.calls[0].params.fields.message;
  // Card must reduce OAuth/disk state to presence/error-code only.
  assert.doesNotMatch(cardText, /super-secret-portal/);
  assert.doesNotMatch(cardText, /MEMBER-SECRET-ID/);
  assert.doesNotMatch(cardText, /555/);
  assert.doesNotMatch(cardText, /777/);
  assert.doesNotMatch(cardText, /client_secret/);
  assert.doesNotMatch(cardText, /ABCDEF123456/);
  assert.doesNotMatch(cardText, /leaked/);

  // The file is allowed (and expected) to carry the full already-redacted
  // bundle + serverSlice as-is — that is its entire purpose.
  const decoded = JSON.parse(Buffer.from(bitrixClient.calls[0].params.fields.content, 'base64').toString('utf8'));
  assert.equal(decoded.serverSlice.oauth.domain, 'super-secret-portal.bitrix24.ru');
});

test('createDiagChatNotifier: throws when bitrixClient is missing (fail fast on misconfiguration, like sibling notification services)', () => {
  assert.throws(() => createDiagChatNotifier({ dialogId: 'chat1', resolveBotId: async () => 1 }));
});
