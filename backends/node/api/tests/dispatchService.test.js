import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSlotKey,
  pickJitterMinutes,
  createDispatchService
} from '../src/dispatch/dispatchService.js';

const createStoreFake = () => {
  let seq = 10;
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

test('pickJitterMinutes returns deterministic range value', () => {
  const value = pickJitterMinutes(10, () => 0);
  assert.equal(value, -10);
});

test('buildSlotKey uses date and normalized HHmm', () => {
  assert.equal(buildSlotKey({ slotDate: '2026-04-28', slotHHmm: '09:30' }), '2026-04-28:0930');
});

test('dispatch service prevents duplicates by slot + azs and applies jitter', async () => {
  const store = createStoreFake();
  const createdReports = [];
  const notifiedUsers = [];

  const service = createDispatchService({
    dispatchLogStore: store,
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            timeoutMinutes: 60,
            dispatchJitterMinutes: 15,
            fields: {
              azs: 'UF_AZS',
              admin: 'UF_ADMIN',
              slotTime: 'UF_SLOT',
              scheduledAt: 'UF_SCHEDULED',
              deadlineAt: 'UF_DEADLINE',
              trigger: 'UF_TRIGGER'
            },
            stages: {
              new: 'DT163_1:NEW'
            }
          }
        };
      }
    },
    bitrixClient: {
      async createReportItem(payload) {
        createdReports.push(payload);
        return { reportItemId: 7001 };
      }
    },
    notificationService: {
      async notifyDispatch(payload) {
        notifiedUsers.push(payload);
      }
    },
    nowFn: () => new Date('2026-04-28T00:00:00.000Z'),
    rng: () => 1
  });

  const candidates = [
    { azsId: 'azs-1', adminUserId: 11, slotDate: '2026-04-28', slotHHmm: '0930' },
    { azsId: 'azs-1', adminUserId: 11, slotDate: '2026-04-28', slotHHmm: '0930' }
  ];

  const result = await service.dispatchBatch({ candidates, trigger: 'auto' });

  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.duplicates, 1);
  assert.equal(result.summary.failed, 0);
  assert.equal(createdReports.length, 1);
  assert.equal(notifiedUsers.length, 1);
  // notifyDispatch is addressed to the AZS admin. (reportId was intentionally
  // dropped from the notification payload in 2419f8a; it is no longer part of
  // the contract — assert the field that still is.)
  assert.equal(notifiedUsers[0].userId, 11);
  assert.equal(result.items[0].jitterMinutes, 15);
});

test('manual trigger does not block auto slot for same azs and hhmm', async () => {
  const store = createStoreFake();
  const createdReports = [];

  const service = createDispatchService({
    dispatchLogStore: store,
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            timeoutMinutes: 60,
            dispatchJitterMinutes: 0,
            fields: {
              azs: 'UF_AZS',
              admin: 'UF_ADMIN',
              slotTime: 'UF_SLOT',
              scheduledAt: 'UF_SCHEDULED',
              deadlineAt: 'UF_DEADLINE',
              trigger: 'UF_TRIGGER'
            },
            stages: {
              new: 'DT163_1:NEW'
            }
          }
        };
      }
    },
    bitrixClient: {
      async createReportItem(payload) {
        createdReports.push(payload);
        return { reportItemId: 7002 + createdReports.length };
      }
    },
    notificationService: {
      async notifyDispatch() {}
    },
    nowFn: () => new Date('2026-04-28T00:00:00.000Z'),
    rng: () => 0.5
  });

  const candidate = { azsId: 'azs-9', adminUserId: 11, slotDate: '2026-04-28', slotHHmm: '0930' };

  const manualResult = await service.dispatchBatch({ candidates: [candidate], trigger: 'manual' });
  const autoResult = await service.dispatchBatch({ candidates: [candidate], trigger: 'auto' });

  assert.equal(manualResult.summary.created, 1);
  assert.equal(manualResult.summary.duplicates, 0);
  assert.equal(autoResult.summary.created, 1);
  assert.equal(autoResult.summary.duplicates, 0);
  assert.equal(createdReports.length, 2);
});

test('pre-computed scheduledAt is used verbatim, jitter NOT re-applied', async () => {
  const markDoneCalls = [];
  const createdReports = [];

  // rng=()=>0 would produce -240 jitter from a 240-minute limit
  // The candidate carries scheduledAt='2026-05-04T09:37:00.000Z' and jitterMinutes=-143
  // We must verify the rng is NOT called and the pre-computed values are used as-is.
  let rngCallCount = 0;

  const store = {
    async reserve() { return { reserved: true, id: 42 }; },
    async markDone(args) { markDoneCalls.push(args); },
    async markFailed() {}
  };

  const service = createDispatchService({
    dispatchLogStore: store,
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            timeoutMinutes: 30,
            dispatchJitterMinutes: 240,
            fields: {},
            stages: { new: 'DT163_1:NEW' }
          }
        };
      }
    },
    bitrixClient: {
      async createReportItem(payload) {
        createdReports.push(payload);
        return { reportItemId: 8001 };
      }
    },
    notificationService: { async notifyDispatch() {} },
    rng: () => { rngCallCount += 1; return 0; } // would give -240 if called
  });

  const candidate = {
    azsId: 'azs-5',
    adminUserId: 99,
    slotDate: '2026-05-04',
    slotHHmm: '1200',
    scheduledAt: '2026-05-04T09:37:00.000Z',
    jitterMinutes: -143
  };

  const settings = {
    report: {
      entityTypeId: 163,
      timeoutMinutes: 30,
      dispatchJitterMinutes: 240,
      fields: {},
      stages: { new: 'DT163_1:NEW' }
    }
  };

  const result = await service.dispatchCandidate({ candidate, settings, trigger: 'auto' });

  assert.equal(result.ok, true, 'should succeed');
  assert.equal(result.duplicate, false);

  // rng must NOT have been called
  assert.equal(rngCallCount, 0, 'rng must not be called when scheduledAt is pre-computed');

  // begindate must equal the pre-computed scheduledAt exactly
  assert.equal(createdReports.length, 1);
  assert.equal(createdReports[0].fields.begindate, '2026-05-04T09:37:00.000Z', 'begindate must be pre-computed scheduledAt');

  // closedate must be scheduledAt + 30 minutes
  const expectedClosedate = new Date('2026-05-04T09:37:00.000Z').getTime() + 30 * 60 * 1000;
  assert.equal(new Date(createdReports[0].fields.closedate).getTime(), expectedClosedate, 'closedate must be scheduledAt + timeoutMinutes');

  // markDone must receive jitterMinutes=-143 and scheduledAt=the pre-computed date
  assert.equal(markDoneCalls.length, 1);
  assert.equal(markDoneCalls[0].jitterMinutes, -143, 'markDone jitterMinutes must be pre-computed -143');
  assert.equal(markDoneCalls[0].scheduledAt.toISOString(), '2026-05-04T09:37:00.000Z', 'markDone scheduledAt must be pre-computed date');
});

test('without pre-computed scheduledAt (legacy path) jitter is still applied from rng', async () => {
  const markDoneCalls = [];
  const createdReports = [];

  const store = {
    async reserve() { return { reserved: true, id: 43 }; },
    async markDone(args) { markDoneCalls.push(args); },
    async markFailed() {}
  };

  const service = createDispatchService({
    dispatchLogStore: store,
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            timeoutMinutes: 60,
            dispatchJitterMinutes: 0,
            fields: {},
            stages: { new: 'DT163_1:NEW' }
          }
        };
      }
    },
    bitrixClient: {
      async createReportItem(payload) {
        createdReports.push(payload);
        return { reportItemId: 8002 };
      }
    },
    notificationService: { async notifyDispatch() {} },
    rng: () => 0.5 // irrelevant because jitterLimit=0, but should be usable
  });

  // No scheduledAt on the candidate — legacy path
  const candidate = {
    azsId: 'azs-6',
    adminUserId: 88,
    slotDate: '2026-05-05',
    slotHHmm: '1000'
  };

  const settings = {
    report: {
      entityTypeId: 163,
      timeoutMinutes: 60,
      dispatchJitterMinutes: 0,
      fields: {},
      stages: { new: 'DT163_1:NEW' }
    }
  };

  const result = await service.dispatchCandidate({ candidate, settings, trigger: 'auto' });

  assert.equal(result.ok, true);

  // With jitterLimit=0, jitter=0, so scheduledAt === plannedAt = 2026-05-05T10:00:00.000Z
  assert.equal(createdReports.length, 1);
  assert.equal(createdReports[0].fields.begindate, '2026-05-05T10:00:00.000Z', 'begindate must equal base slot time with no jitter');
  assert.equal(markDoneCalls[0].jitterMinutes, 0, 'jitterMinutes must be 0 with zero limit');
  assert.equal(markDoneCalls[0].scheduledAt.toISOString(), '2026-05-05T10:00:00.000Z', 'scheduledAt must equal base slot time');
});

test('invalid pre-computed scheduledAt causes candidate to fail gracefully', async () => {
  const markFailedCalls = [];
  const errorLogs = [];

  const store = {
    async reserve() { return { reserved: true, id: 44 }; },
    async markDone() {},
    async markFailed(args) { markFailedCalls.push(args); }
  };

  const service = createDispatchService({
    dispatchLogStore: store,
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            timeoutMinutes: 60,
            dispatchJitterMinutes: 0,
            fields: {},
            stages: {}
          }
        };
      }
    },
    bitrixClient: {
      async createReportItem() { return { reportItemId: 9999 }; }
    },
    notificationService: { async notifyDispatch() {} },
    logger: {
      warn() {},
      error(msg, meta) { errorLogs.push({ msg, meta }); }
    }
  });

  const candidate = {
    azsId: 'azs-7',
    adminUserId: 77,
    slotDate: '2026-05-05',
    slotHHmm: '0900',
    scheduledAt: 'not-a-date'
  };

  const settings = {
    report: {
      entityTypeId: 163,
      timeoutMinutes: 60,
      dispatchJitterMinutes: 0,
      fields: {},
      stages: {}
    }
  };

  const result = await service.dispatchCandidate({ candidate, settings, trigger: 'auto' });

  assert.equal(result.ok, false, 'must fail when scheduledAt is invalid');
  assert.match(result.error, /invalid/i, 'error message must mention "invalid"');
  assert.equal(markFailedCalls.length, 1, 'markFailed must be called');
  assert.match(markFailedCalls[0].errorText, /invalid/i, 'markFailed errorText must mention "invalid"');
});

// BUG-019: кнопка причины теперь COMMAND, не LINK
test('dispatchCandidate: клавиатура содержит COMMAND-кнопку причины при наличии BITRIX_APP_CODE', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;

  process.env.BITRIX_APP_CODE = 'test.app';

  try {
    const notifyCalls = [];

    const service = createDispatchService({
      dispatchLogStore: {
        async reserve() { return { reserved: true, id: 42 }; },
        async markDone() {},
        async markFailed() {}
      },
      settingsStore: {
        async read() {
          return {
            report: {
              entityTypeId: 163,
              timeoutMinutes: 60,
              dispatchJitterMinutes: 0,
              fields: {
                azs: 'UF_AZS',
                admin: 'UF_ADMIN',
                slotTime: 'UF_SLOT',
                scheduledAt: 'UF_SCHEDULED',
                deadlineAt: 'UF_DEADLINE',
                trigger: 'UF_TRIGGER'
              },
              stages: { new: 'DT163_1:NEW' }
            }
          };
        }
      },
      bitrixClient: {
        async createReportItem() { return { reportItemId: 7777 }; }
      },
      notificationService: {
        async notifyDispatch(payload) { notifyCalls.push(payload); }
      },
      nowFn: () => new Date('2026-04-28T00:00:00.000Z'),
      rng: () => 0.5
    });

    const settings = {
      report: {
        entityTypeId: 163,
        timeoutMinutes: 60,
        dispatchJitterMinutes: 0,
        fields: {
          azs: 'UF_AZS',
          admin: 'UF_ADMIN',
          slotTime: 'UF_SLOT',
          scheduledAt: 'UF_SCHEDULED',
          deadlineAt: 'UF_DEADLINE',
          trigger: 'UF_TRIGGER'
        },
        stages: { new: 'DT163_1:NEW' }
      }
    };

    const candidate = {
      azsId: 'azs-10',
      adminUserId: 42,
      slotDate: '2026-04-28',
      slotHHmm: '1000'
    };

    await service.dispatchCandidate({ candidate, settings, trigger: 'auto' });

    assert.equal(notifyCalls.length, 1, 'notifyDispatch должен быть вызван');
    const keyboard = notifyCalls[0].keyboard;
    // W1-1: flat {BOT_ID, BUTTONS} format — no nested arrays
    assert.ok(
      keyboard !== null && keyboard !== undefined && typeof keyboard === 'object' && !Array.isArray(keyboard),
      'keyboard должна быть объектом с BOT_ID и BUTTONS'
    );
    assert.ok(Array.isArray(keyboard.BUTTONS) && keyboard.BUTTONS.length > 0, 'keyboard.BUTTONS должна быть непустым массивом');
    for (const btn of keyboard.BUTTONS) {
      assert.ok(!Array.isArray(btn), 'keyboard.BUTTONS элементы не должны быть массивами (плоский формат)');
    }

    // BUG-019: reason button is COMMAND type, not LINK
    const reasonButton = keyboard.BUTTONS.find((b) => b?.TEXT?.includes('Не успеваю') || b?.TEXT?.includes('причину'));
    assert.ok(reasonButton, 'клавиатура должна содержать кнопку причины');
    assert.equal(reasonButton.TYPE, 'COMMAND', 'кнопка причины должна быть TYPE=COMMAND (BUG-019)');
    assert.ok(String(reasonButton.COMMAND).includes('reason'), 'COMMAND должен содержать "reason"');
    assert.equal(reasonButton.LINK, undefined, 'COMMAND-кнопка не должна иметь LINK');
  } finally {
    // Восстановить env чтобы не загрязнять другие тесты
    if (prevAppCode === undefined) delete process.env.BITRIX_APP_CODE;
    else process.env.BITRIX_APP_CODE = prevAppCode;
  }
});

test('dispatch persists report item id even when notification fails', async () => {
  const store = createStoreFake();
  const warnLogs = [];

  const service = createDispatchService({
    dispatchLogStore: store,
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            timeoutMinutes: 60,
            dispatchJitterMinutes: 0,
            fields: {
              azs: 'UF_AZS',
              trigger: 'UF_TRIGGER'
            },
            stages: {
              new: 'DT163_1:NEW'
            }
          }
        };
      }
    },
    bitrixClient: {
      async createReportItem() {
        return { reportItemId: 9090 };
      }
    },
    notificationService: {
      async notifyDispatch() {
        throw new Error('notify failed');
      }
    },
    nowFn: () => new Date('2026-04-28T00:00:00.000Z'),
    logger: {
      warn(payload, meta) {
        warnLogs.push({ payload, meta });
      },
      error() {}
    }
  });

  const result = await service.dispatchBatch({
    candidates: [
      { azsId: 'azs-77', adminUserId: 11, slotDate: '2026-04-28', slotHHmm: '1845' }
    ],
    trigger: 'auto'
  });

  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.items[0].reportItemId, 9090);
  const state = [...store.states.values()][0];
  assert.equal(state.reportItemId, 9090);
  assert.equal(warnLogs.length, 1);
});
