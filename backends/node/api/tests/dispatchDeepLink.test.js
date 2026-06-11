import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchService } from '../src/dispatch/dispatchService.js';
import { NOTIFY_FALLBACK_PREFIX } from '../src/notifications/notificationService.js';

const createStoreFake = () => {
  let seq = 20;
  const reservations = new Map();
  const states = new Map();

  return {
    states,
    async reserve({ slotKey, azsId }) {
      const key = `${slotKey}:${azsId}`;
      if (reservations.has(key)) {
        return { reserved: false, id: null };
      }
      seq += 1;
      reservations.set(key, seq);
      states.set(seq, { status: 'reserved' });
      return { reserved: true, id: seq };
    },
    async markDone({ id, reportItemId, jitterMinutes }) {
      states.set(id, { status: 'done', reportItemId, jitterMinutes });
    },
    async markFailed({ id, errorText }) {
      states.set(id, { status: 'failed', errorText });
    }
  };
};

const baseSettings = {
  report: {
    entityTypeId: 163,
    timeoutMinutes: 60,
    dispatchJitterMinutes: 0,
    fields: { azs: 'UF_AZS', trigger: 'UF_TRIGGER' },
    stages: { new: 'DT163_1:NEW' }
  }
};

const baseCandidate = {
  azsId: 'azs-deeplink-1',
  adminUserId: 42,
  slotDate: '2026-05-31',
  slotHHmm: '1000'
};

test('BITRIX_APP_CODE unset — notifyDispatch receives no keyboard', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    delete process.env.BITRIX_APP_CODE;

    const notifiedPayloads = [];
    const service = createDispatchService({
      dispatchLogStore: createStoreFake(),
      settingsStore: { async read() { return baseSettings; } },
      bitrixClient: {
        async createReportItem() { return { reportItemId: 5501 }; }
      },
      notificationService: {
        async notifyDispatch(payload) { notifiedPayloads.push(payload); }
      },
      nowFn: () => new Date('2026-05-31T10:00:00.000Z'),
      rng: () => 0
    });

    await service.dispatchBatch({ candidates: [baseCandidate], trigger: 'auto' });

    assert.equal(notifiedPayloads.length, 1, 'should call notifyDispatch exactly once');
    assert.equal(notifiedPayloads[0].keyboard, null, 'keyboard must be null when BITRIX_APP_CODE is not set');
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});

test('BITRIX_APP_CODE empty string — notifyDispatch receives no keyboard', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    process.env.BITRIX_APP_CODE = '';

    const notifiedPayloads = [];
    const service = createDispatchService({
      dispatchLogStore: createStoreFake(),
      settingsStore: { async read() { return baseSettings; } },
      bitrixClient: {
        async createReportItem() { return { reportItemId: 5502 }; }
      },
      notificationService: {
        async notifyDispatch(payload) { notifiedPayloads.push(payload); }
      },
      nowFn: () => new Date('2026-05-31T10:00:00.000Z'),
      rng: () => 0
    });

    await service.dispatchBatch({ candidates: [{ ...baseCandidate, azsId: 'azs-deeplink-2' }], trigger: 'auto' });

    assert.equal(notifiedPayloads.length, 1);
    assert.equal(notifiedPayloads[0].keyboard, null, 'keyboard must be null when BITRIX_APP_CODE is empty');
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});

test('BITRIX_APP_CODE set — notifyDispatch receives keyboard with «Открыть приложение» button containing reportId', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    process.env.BITRIX_APP_CODE = 'local.test.app123';

    const notifiedPayloads = [];
    const service = createDispatchService({
      dispatchLogStore: createStoreFake(),
      settingsStore: { async read() { return baseSettings; } },
      bitrixClient: {
        async createReportItem() { return { reportItemId: 5503 }; }
      },
      notificationService: {
        async notifyDispatch(payload) { notifiedPayloads.push(payload); }
      },
      nowFn: () => new Date('2026-05-31T10:00:00.000Z'),
      rng: () => 0
    });

    await service.dispatchBatch({ candidates: [{ ...baseCandidate, azsId: 'azs-deeplink-3' }], trigger: 'auto' });

    assert.equal(notifiedPayloads.length, 1);
    const { keyboard } = notifiedPayloads[0];
    assert.ok(keyboard !== null && keyboard !== undefined, 'keyboard must be present when BITRIX_APP_CODE is set');
    // W1-1: flat {BOT_ID, BUTTONS} format
    assert.ok(typeof keyboard === 'object' && !Array.isArray(keyboard), 'keyboard must be a plain object (not array)');
    assert.ok(Array.isArray(keyboard.BUTTONS), 'keyboard.BUTTONS must be an array');
    assert.ok(keyboard.BUTTONS.length > 0, 'keyboard.BUTTONS must not be empty');
    // No nested arrays — each element must be a plain object
    for (const btn of keyboard.BUTTONS) {
      assert.ok(!Array.isArray(btn), 'keyboard.BUTTONS elements must NOT be arrays (flat format)');
    }
    const firstButton = keyboard.BUTTONS[0];
    assert.equal(firstButton.TEXT, 'Открыть приложение', 'first button text must be «Открыть приложение»');
    assert.ok(typeof firstButton.LINK === 'string', 'button must have a LINK');
    assert.match(firstButton.LINK, /\/marketplace\/view\//, 'link must contain /marketplace/view/');
    assert.match(firstButton.LINK, /5503/, 'link must contain the reportItemId');
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});

test('BITRIX_APP_CODE set — keyboard second button is «Не успеваю — указать причину» with reason deep-link, NEWLINE separator', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    process.env.BITRIX_APP_CODE = 'local.test.app123';

    const notifiedPayloads = [];
    const service = createDispatchService({
      dispatchLogStore: createStoreFake(),
      settingsStore: { async read() { return baseSettings; } },
      bitrixClient: {
        async createReportItem() { return { reportItemId: 5510 }; }
      },
      notificationService: {
        async notifyDispatch(payload) { notifiedPayloads.push(payload); }
      },
      nowFn: () => new Date('2026-05-31T10:00:00.000Z'),
      rng: () => 0
    });

    await service.dispatchBatch({ candidates: [{ ...baseCandidate, azsId: 'azs-deeplink-5' }], trigger: 'auto' });

    assert.equal(notifiedPayloads.length, 1);
    const { keyboard } = notifiedPayloads[0];
    // W1-1: flat {BOT_ID, BUTTONS} format — no nested arrays
    assert.ok(keyboard !== null && keyboard !== undefined, 'keyboard must be present');
    assert.ok(typeof keyboard === 'object' && !Array.isArray(keyboard), 'keyboard must be a plain object');
    assert.ok(Array.isArray(keyboard.BUTTONS), 'keyboard.BUTTONS must be an array');
    for (const btn of keyboard.BUTTONS) {
      assert.ok(!Array.isArray(btn), 'keyboard.BUTTONS elements must NOT be arrays (flat format)');
    }
    // Structure: [openBtn, NEWLINE, reasonBtn]
    assert.ok(keyboard.BUTTONS.length >= 3, 'must have at least 3 elements (2 buttons + NEWLINE)');
    assert.equal(keyboard.BUTTONS[1].TYPE, 'NEWLINE', 'NEWLINE must be between buttons');
    const secondButton = keyboard.BUTTONS[2];
    assert.ok(secondButton, 'second button must exist');
    assert.equal(secondButton.TEXT, 'Не успеваю — указать причину', 'second button text must be for reason');
    assert.match(secondButton.LINK, /\/marketplace\/view\//, 'reason link must contain /marketplace/view/');
    assert.match(secondButton.LINK, /reason/, 'reason link must contain /reason/');
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});

test('BITRIX_APP_CODE missing — keyboard is null (defensive, no appCode)', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    delete process.env.BITRIX_APP_CODE;

    const notifiedPayloads = [];
    const service = createDispatchService({
      dispatchLogStore: createStoreFake(),
      settingsStore: { async read() { return baseSettings; } },
      bitrixClient: {
        async createReportItem() { return { reportItemId: 5504 }; }
      },
      notificationService: {
        async notifyDispatch(payload) { notifiedPayloads.push(payload); }
      },
      nowFn: () => new Date('2026-05-31T10:00:00.000Z'),
      rng: () => 0
    });

    await service.dispatchBatch({ candidates: [{ ...baseCandidate, azsId: 'azs-deeplink-4' }], trigger: 'auto' });

    assert.equal(notifiedPayloads.length, 1);
    assert.equal(notifiedPayloads[0].keyboard, null, 'keyboard must be null when appCode is missing');
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});

// W1-2: bot fell, notify fallback delivered → appendErrorText called with NOTIFY_FALLBACK_PREFIX
test('W1-2: notify fallback → appendErrorText annotated with NOTIFY_FALLBACK_PREFIX, success status kept', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    process.env.BITRIX_APP_CODE = '';

    const appendErrorTextCalls = [];
    const store = {
      ...createStoreFake(),
      async appendErrorText(payload) { appendErrorTextCalls.push(payload); }
    };

    const service = createDispatchService({
      dispatchLogStore: store,
      settingsStore: { async read() { return baseSettings; } },
      bitrixClient: {
        async createReportItem() { return { reportItemId: 5600 }; }
      },
      notificationService: {
        async notifyDispatch() {
          return { delivered: true, channel: 'notify', result: { ok: true }, botError: 'PARAM_KEYBOARD_ERROR' };
        }
      },
      nowFn: () => new Date('2026-05-31T10:00:00.000Z'),
      rng: () => 0
    });

    const batchResult = await service.dispatchBatch({ candidates: [{ ...baseCandidate, azsId: 'azs-fallback-1' }] });

    // dispatch itself succeeds (ok: true)
    assert.equal(batchResult.items[0].ok, true, 'dispatch ok must remain true on notify fallback');
    assert.equal(appendErrorTextCalls.length, 1, 'appendErrorText must be called once');
    assert.ok(
      appendErrorTextCalls[0].errorText.startsWith(NOTIFY_FALLBACK_PREFIX),
      'error_text must start with NOTIFY_FALLBACK_PREFIX'
    );
    assert.ok(
      appendErrorTextCalls[0].errorText.includes('PARAM_KEYBOARD_ERROR'),
      'error_text must include the bot error reason'
    );
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});
