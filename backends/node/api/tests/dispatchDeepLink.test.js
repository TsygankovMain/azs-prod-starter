import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchService } from '../src/dispatch/dispatchService.js';

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

test('ENABLE_REPORT_DEEP_LINK unset — notifyDispatch receives no keyboard', async () => {
  const prevValue = process.env.ENABLE_REPORT_DEEP_LINK;
  try {
    delete process.env.ENABLE_REPORT_DEEP_LINK;

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
    assert.equal(notifiedPayloads[0].keyboard, null, 'keyboard must be null when flag is off');
  } finally {
    if (prevValue === undefined) {
      delete process.env.ENABLE_REPORT_DEEP_LINK;
    } else {
      process.env.ENABLE_REPORT_DEEP_LINK = prevValue;
    }
  }
});

test('ENABLE_REPORT_DEEP_LINK=false — notifyDispatch receives no keyboard', async () => {
  const prevValue = process.env.ENABLE_REPORT_DEEP_LINK;
  try {
    process.env.ENABLE_REPORT_DEEP_LINK = 'false';

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
    assert.equal(notifiedPayloads[0].keyboard, null, 'keyboard must be null when flag is explicitly false');
  } finally {
    if (prevValue === undefined) {
      delete process.env.ENABLE_REPORT_DEEP_LINK;
    } else {
      process.env.ENABLE_REPORT_DEEP_LINK = prevValue;
    }
  }
});

test('ENABLE_REPORT_DEEP_LINK=true — notifyDispatch receives keyboard with deep-link containing reportId and /marketplace/view/', async () => {
  const prevValue = process.env.ENABLE_REPORT_DEEP_LINK;
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    process.env.ENABLE_REPORT_DEEP_LINK = 'true';
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
    assert.ok(keyboard !== null && keyboard !== undefined, 'keyboard must be present when flag is true');
    assert.ok(Array.isArray(keyboard), 'keyboard must be an array');
    assert.ok(keyboard.length > 0, 'keyboard must not be empty');
    const firstButton = keyboard[0][0];
    assert.ok(typeof firstButton.LINK === 'string', 'button must have a LINK');
    assert.match(firstButton.LINK, /\/marketplace\/view\//, 'link must contain /marketplace/view/');
    assert.match(firstButton.LINK, /5503/, 'link must contain the reportItemId');
  } finally {
    if (prevValue === undefined) {
      delete process.env.ENABLE_REPORT_DEEP_LINK;
    } else {
      process.env.ENABLE_REPORT_DEEP_LINK = prevValue;
    }
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});

test('ENABLE_REPORT_DEEP_LINK=true but BITRIX_APP_CODE missing — keyboard is null (defensive)', async () => {
  const prevValue = process.env.ENABLE_REPORT_DEEP_LINK;
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    process.env.ENABLE_REPORT_DEEP_LINK = 'true';
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
    if (prevValue === undefined) {
      delete process.env.ENABLE_REPORT_DEEP_LINK;
    } else {
      process.env.ENABLE_REPORT_DEEP_LINK = prevValue;
    }
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});
