/**
 * BUG-019: Проверяет, что keyboard в dispatchService и timeoutWatcher
 * содержит COMMAND-кнопку «Не успеваю — указать причину»,
 * а кнопки LINK «Открыть приложение» НЕТ.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchService } from '../src/dispatch/dispatchService.js';
import { createTimeoutWatcher } from '../src/dispatch/timeoutWatcher.js';

// ─── shared helpers ──────────────────────────────────────────────────────────

const createStoreFake = () => {
  let seq = 100;
  const reservations = new Map();
  const states = new Map();
  return {
    states,
    appendErrorTextCalls: [],
    async reserve({ slotKey, azsId }) {
      const key = `${slotKey}:${azsId}`;
      if (reservations.has(key)) return { reserved: false, id: null };
      seq += 1;
      reservations.set(key, seq);
      states.set(seq, { status: 'reserved' });
      return { reserved: true, id: seq };
    },
    async markDone({ id, reportItemId }) {
      states.set(id, { status: 'done', reportItemId });
    },
    async markFailed({ id, errorText }) {
      states.set(id, { status: 'failed', errorText });
    },
    async appendErrorText(payload) {
      this.appendErrorTextCalls.push(payload);
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
  azsId: 'azs-cmd-1',
  adminUserId: 55,
  slotDate: '2026-06-12',
  slotHHmm: '1000'
};

// ─── dispatchService: keyboard contains COMMAND button, no LINK open-app ─────

test('BUG-019 dispatch: keyboard has COMMAND reason button and NO open-app LINK button', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    process.env.BITRIX_APP_CODE = 'local.test.cmd1';

    const notifiedPayloads = [];
    const service = createDispatchService({
      dispatchLogStore: createStoreFake(),
      settingsStore: { async read() { return baseSettings; } },
      bitrixClient: {
        async createReportItem() { return { reportItemId: 6001 }; }
      },
      notificationService: {
        async notifyDispatch(payload) { notifiedPayloads.push(payload); }
      },
      nowFn: () => new Date('2026-06-12T10:00:00.000Z'),
      rng: () => 0
    });

    await service.dispatchBatch({ candidates: [baseCandidate], trigger: 'auto' });

    assert.equal(notifiedPayloads.length, 1);
    const { keyboard } = notifiedPayloads[0];

    // Keyboard must be present
    assert.ok(keyboard !== null && keyboard !== undefined, 'keyboard must be present');
    assert.ok(Array.isArray(keyboard.BUTTONS), 'keyboard.BUTTONS must be an array');

    // Must have at least one non-NEWLINE button
    const realButtons = keyboard.BUTTONS.filter(b => b.TYPE !== 'NEWLINE');
    assert.ok(realButtons.length >= 1, 'must have at least one real button');

    // NO button with TEXT «Открыть приложение» must exist
    const openAppButton = realButtons.find(b => b.TEXT === 'Открыть приложение');
    assert.equal(openAppButton, undefined, '«Открыть приложение» LINK button must be REMOVED');

    // «Указать причину» button must exist and be COMMAND type
    const reasonButton = realButtons.find(b => String(b.TEXT || '').includes('причину') || String(b.TEXT || '').includes('Указать'));
    assert.ok(reasonButton !== undefined, '«Указать причину» button must exist');
    assert.equal(reasonButton.TYPE, 'COMMAND', '«Указать причину» button must be TYPE=COMMAND');
    assert.ok(typeof reasonButton.COMMAND === 'string' && reasonButton.COMMAND.length > 0,
      'COMMAND button must have a COMMAND field (the command string)');
    // Must NOT have LINK property
    assert.equal(reasonButton.LINK, undefined, 'COMMAND button must NOT have a LINK property');
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});

test('BUG-019 dispatch: COMMAND button COMMAND string contains reportId', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    process.env.BITRIX_APP_CODE = 'local.test.cmd2';

    const notifiedPayloads = [];
    const service = createDispatchService({
      dispatchLogStore: createStoreFake(),
      settingsStore: { async read() { return baseSettings; } },
      bitrixClient: {
        async createReportItem() { return { reportItemId: 6002 }; }
      },
      notificationService: {
        async notifyDispatch(payload) { notifiedPayloads.push(payload); }
      },
      nowFn: () => new Date('2026-06-12T10:00:00.000Z'),
      rng: () => 0
    });

    await service.dispatchBatch({ candidates: [{ ...baseCandidate, azsId: 'azs-cmd-2' }], trigger: 'auto' });

    const { keyboard } = notifiedPayloads[0];
    const realButtons = keyboard.BUTTONS.filter(b => b.TYPE !== 'NEWLINE');
    const reasonButton = realButtons.find(b => String(b.TEXT || '').includes('причину') || String(b.TEXT || '').includes('Указать'));
    assert.ok(reasonButton, 'reason button must exist');
    // COMMAND value must embed the reportId so the bot knows which report to annotate
    assert.ok(
      String(reasonButton.COMMAND).includes('reason') || String(reasonButton.COMMAND).match(/\d+/),
      'COMMAND string must reference the report (contain "reason" or a numeric id)'
    );
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});

// ─── timeoutWatcher: overdue reason keyboard also uses COMMAND button ─────────

test('BUG-019 timeoutWatcher: overdue reason keyboard has COMMAND button, no LINK', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    process.env.BITRIX_APP_CODE = 'local.test.cmd3';

    const notifyCalls = [];
    const fakeReportsStore = {
      async listOverdueReports() {
        return [{ id: 77, azsId: 'azs-tw-1', adminUserId: 5, status: 'pending', deadlineAt: new Date('2026-06-11T10:00:00.000Z') }];
      },
      async setReportStatus() {}
    };
    const fakeReasonStore = {
      async getByReport() { return null; } // no reason yet → should build keyboard
    };

    const watcher = createTimeoutWatcher({
      reportsStore: fakeReportsStore,
      dispatchLogStore: null,
      bitrixClient: {
        async callMethod() { return { ok: true }; }
      },
      settingsStore: {
        async read() { return {}; }
      },
      notificationService: {
        get botId() { return 888; },
        async notify(payload) { notifyCalls.push(payload); return { channel: 'bot', delivered: true }; },
        async notifyReportExpired() {}
      },
      reasonStore: fakeReasonStore,
      nowFn: () => new Date('2026-06-12T10:00:00.000Z')
    });

    await watcher.runOnce({});

    const callWithKeyboard = notifyCalls.find(c => c.keyboard != null);
    assert.ok(callWithKeyboard !== undefined, 'at least one notify call must include a keyboard');

    const { keyboard } = callWithKeyboard;
    assert.ok(Array.isArray(keyboard.BUTTONS), 'keyboard.BUTTONS must be an array');

    const realButtons = keyboard.BUTTONS.filter(b => b.TYPE !== 'NEWLINE');
    const openAppBtn = realButtons.find(b => b.TEXT === 'Открыть приложение');
    assert.equal(openAppBtn, undefined, '«Открыть приложение» must not exist in overdue keyboard');

    const reasonBtn = realButtons.find(b => String(b.TEXT || '').includes('причину') || String(b.TEXT || '').includes('Указать'));
    assert.ok(reasonBtn !== undefined, '«Указать причину» button must exist in overdue keyboard');
    assert.equal(reasonBtn.TYPE, 'COMMAND', 'overdue reason button must be COMMAND type');
    assert.equal(reasonBtn.LINK, undefined, 'overdue COMMAND button must not have LINK');
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});
