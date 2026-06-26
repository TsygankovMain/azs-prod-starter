import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeoutWatcher } from '../src/dispatch/timeoutWatcher.js';

test('timeout watcher expires overdue reports and skips done/expired', async () => {
  const changed = [];
  const notifications = [];
  const updates = [];

  const watcher = createTimeoutWatcher({
    reportsStore: {
      async listOverdueReports() {
        return [
          { id: 1, azsId: 'azs-1', slotKey: '2026-04-28:0900', status: 'new' },
          { id: 2, azsId: 'azs-2', slotKey: '2026-04-28:1000', status: 'in_progress' },
          { id: 3, azsId: 'azs-3', slotKey: '2026-04-28:1100', status: 'done' },
          { id: 4, azsId: 'azs-4', slotKey: '2026-04-28:1200', status: 'expired' }
        ];
      },
      async setReportStatus({ reportId, status }) {
        changed.push({ reportId, status });
      }
    },
    bitrixClient: {
      async updateReportItem(payload) {
        updates.push(payload);
      }
    },
    notificationService: {
      async notifyReportExpired(payload) {
        notifications.push(payload);
      }
    },
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            stages: {
              expired: 'DT163_1:EXPIRED'
            }
          }
        };
      }
    },
    reviewerUserId: 11
  });

  const summary = await watcher.runOnce();

  assert.equal(summary.total, 4);
  assert.equal(summary.expired, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 2);
  assert.equal(summary.notified, 2);
  assert.deepEqual(changed, [
    { reportId: 1, status: 'expired' },
    { reportId: 2, status: 'expired' }
  ]);
  assert.equal(notifications.length, 2);
  assert.deepEqual(updates, []);
});

test('timeout watcher updates Bitrix report stage when crm report id exists', async () => {
  const updates = [];

  const watcher = createTimeoutWatcher({
    reportsStore: {
      async listOverdueReports() {
        return [
          { id: 1, reportItemId: 7001, azsId: 'azs-1', slotKey: '2026-04-28:0900', status: 'new' }
        ];
      },
      async setReportStatus() {}
    },
    bitrixClient: {
      async updateReportItem(payload) {
        updates.push(payload);
      }
    },
    notificationService: {
      async notifyReportExpired() {}
    },
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            stages: {
              expired: 'DT163_1:EXPIRED'
            }
          }
        };
      }
    },
    reviewerUserId: 0
  });

  const summary = await watcher.runOnce();

  assert.equal(summary.expired, 1);
  assert.deepEqual(updates, [{
    entityTypeId: 163,
    id: 7001,
    fields: {
      stageId: 'DT163_1:EXPIRED'
    },
    context: {}
  }]);
});

test('timeoutWatcher: expired без причины → отправляет добор оператору', async () => {
  const doborNotifyCalls = [];
  const setStatusCalls = [];

  const watcher = createTimeoutWatcher({
    reportsStore: {
      async listOverdueReports() {
        return [
          { id: 10, azsId: 'azs-1', adminUserId: 77, slotKey: '2026-04-28:0900', status: 'in_progress' }
        ];
      },
      async setReportStatus({ reportId, status }) {
        setStatusCalls.push({ reportId, status });
      }
    },
    bitrixClient: {
      async updateReportItem() {}
    },
    notificationService: {
      async notifyReportExpired() {},
      async notify(payload) { doborNotifyCalls.push(payload); }
    },
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            stages: { expired: 'DT163_1:EXPIRED' }
          }
        };
      }
    },
    reasonStore: {
      async getByReport() { return null; }  // нет причины → должен отправить добор
    },
    reviewerUserId: 11
  });

  const summary = await watcher.runOnce();

  assert.equal(summary.expired, 1, 'один отчёт должен быть просрочен');
  assert.equal(doborNotifyCalls.length, 1, 'notify должен быть вызван для добора причины');
  assert.equal(doborNotifyCalls[0].userId, 77, 'добор отправляется оператору отчёта (adminUserId=77)');
  assert.ok(
    doborNotifyCalls[0].message?.includes('причин') || doborNotifyCalls[0].keyboard != null,
    'сообщение или клавиатура добора должны присутствовать'
  );
});

// BUG-019: overdue reason button is now COMMAND (not LINK)
test('timeoutWatcher: expired без причины + BITRIX_APP_CODE → COMMAND-кнопка «Указать причину»', async () => {
  const doborNotifyCalls = [];
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    process.env.BITRIX_APP_CODE = 'local.azs.test456';

    const watcher = createTimeoutWatcher({
      reportsStore: {
        async listOverdueReports() {
          return [
            { id: 30, azsId: 'azs-3', adminUserId: 55, slotKey: '2026-06-01:1000', status: 'in_progress' }
          ];
        },
        async setReportStatus() {}
      },
      bitrixClient: {
        async updateReportItem() {}
      },
      notificationService: {
        async notifyReportExpired() {},
        async notify(payload) { doborNotifyCalls.push(payload); }
      },
      settingsStore: {
        async read() {
          return {
            report: {
              entityTypeId: 163,
              stages: { expired: 'DT163_1:EXPIRED' }
            }
          };
        }
      },
      reasonStore: {
        async getByReport() { return null; }
      },
      reviewerUserId: 0
    });

    await watcher.runOnce();

    assert.equal(doborNotifyCalls.length, 1, 'добор должен быть отправлен');
    const { keyboard } = doborNotifyCalls[0];
    // W1-1: flat {BOT_ID, BUTTONS} format
    assert.ok(keyboard !== null && keyboard !== undefined, 'keyboard должен присутствовать когда есть BITRIX_APP_CODE');
    assert.ok(typeof keyboard === 'object' && !Array.isArray(keyboard), 'keyboard должен быть объектом (не массивом)');
    assert.ok(Array.isArray(keyboard.BUTTONS) && keyboard.BUTTONS.length > 0, 'keyboard.BUTTONS должен быть непустым');
    for (const btn of keyboard.BUTTONS) {
      assert.ok(!Array.isArray(btn), 'keyboard.BUTTONS элементы не должны быть массивами (плоский формат)');
    }
    const btn = keyboard.BUTTONS[0];
    assert.equal(btn.TEXT, 'Указать причину', 'текст кнопки должен быть «Указать причину»');
    // BUG-019 v2: ACTION:SEND button, not LINK/COMMAND
    assert.equal(btn.ACTION, 'SEND', 'кнопка должна быть ACTION=SEND (BUG-019 v2)');
    // REASON-BTN-TEXT: ACTION_VALUE — человеческая фраза, без id отчёта в тексте
    assert.equal(btn.ACTION_VALUE, 'Указать причину', 'ACTION_VALUE — человеческий текст');
    assert.ok(!/\d/.test(String(btn.ACTION_VALUE)), 'в тексте кнопки нет номера отчёта');
    assert.equal(btn.LINK, undefined, 'кнопка причины не должна иметь LINK');

    // NOTIF-BOT-ONLY: notify-фоллбэк удалён — fallbackSuffix больше не передаётся.
    // Кнопка «Указать причину» (ACTION:SEND) всегда уходит ботом в чат.
    assert.equal(doborNotifyCalls[0].fallbackSuffix, undefined, 'fallbackSuffix больше не передаётся (bot-only)');
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});

test('timeoutWatcher: expired без причины + BITRIX_APP_CODE отсутствует → keyboard = null', async () => {
  const doborNotifyCalls = [];
  const prevAppCode = process.env.BITRIX_APP_CODE;
  try {
    delete process.env.BITRIX_APP_CODE;

    const watcher = createTimeoutWatcher({
      reportsStore: {
        async listOverdueReports() {
          return [
            { id: 40, azsId: 'azs-4', adminUserId: 66, slotKey: '2026-06-01:1100', status: 'in_progress' }
          ];
        },
        async setReportStatus() {}
      },
      bitrixClient: {
        async updateReportItem() {}
      },
      notificationService: {
        async notifyReportExpired() {},
        async notify(payload) { doborNotifyCalls.push(payload); }
      },
      settingsStore: {
        async read() {
          return {
            report: {
              entityTypeId: 163,
              stages: { expired: 'DT163_1:EXPIRED' }
            }
          };
        }
      },
      reasonStore: {
        async getByReport() { return null; }
      },
      reviewerUserId: 0
    });

    await watcher.runOnce();

    assert.equal(doborNotifyCalls.length, 1, 'добор должен быть отправлен');
    assert.equal(doborNotifyCalls[0].keyboard, null, 'keyboard должен быть null когда appCode отсутствует');
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});

test('timeoutWatcher: expired с причиной → добор НЕ отправляется', async () => {
  const doborNotifyCalls = [];

  const watcher = createTimeoutWatcher({
    reportsStore: {
      async listOverdueReports() {
        return [
          { id: 20, azsId: 'azs-2', adminUserId: 88, slotKey: '2026-04-28:1000', status: 'in_progress' }
        ];
      },
      async setReportStatus() {}
    },
    bitrixClient: {
      async updateReportItem() {}
    },
    notificationService: {
      async notifyReportExpired() {},
      async notify(payload) { doborNotifyCalls.push(payload); }
    },
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            stages: { expired: 'DT163_1:EXPIRED' }
          }
        };
      }
    },
    reasonStore: {
      async getByReport() {
        // причина уже есть → добор НЕ нужен
        return { id: 5, report_id: 20, reason_code: 'queue', reason_text: null };
      }
    },
    reviewerUserId: 11
  });

  const summary = await watcher.runOnce();

  assert.equal(summary.expired, 1, 'один отчёт просрочен');
  assert.equal(doborNotifyCalls.length, 0, 'добор НЕ должен отправляться если причина уже сохранена');
});

test('timeout watcher counts failures when status update throws', async () => {
  const watcher = createTimeoutWatcher({
    reportsStore: {
      async listOverdueReports() {
        return [
          { id: 10, azsId: 'azs-x', slotKey: '2026-04-28:1300', status: 'new' }
        ];
      },
      async setReportStatus() {
        throw new Error('db unavailable');
      }
    },
    bitrixClient: {
      async notifyUser() {}
    },
    notificationService: {
      async notifyReportExpired() {}
    },
    reviewerUserId: 11
  });

  const summary = await watcher.runOnce();
  assert.equal(summary.total, 1);
  assert.equal(summary.expired, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.notified, 0);
});

test('timeoutWatcher: CRM failure does NOT expire report in DB (status stays overdue for retry)', async () => {
  const setStatusCalls = [];

  const watcher = createTimeoutWatcher({
    reportsStore: {
      async listOverdueReports() {
        return [
          { id: 55, reportItemId: 9001, azsId: 'azs-9', slotKey: '2026-04-28:0900', status: 'in_progress' }
        ];
      },
      async setReportStatus({ reportId, status }) {
        setStatusCalls.push({ reportId, status });
      }
    },
    bitrixClient: {
      async updateReportItem() {
        throw new Error('CRM_CONNECTION_TIMEOUT');
      }
    },
    notificationService: {
      async notifyReportExpired() {}
    },
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            stages: { expired: 'DT163_1:EXPIRED' }
          }
        };
      }
    },
    reviewerUserId: 0
  });

  const summary = await watcher.runOnce();

  assert.equal(summary.expired, 0, 'report must NOT be counted as expired when CRM update failed');
  assert.equal(summary.failed, 1, 'failure must be recorded');
  assert.equal(setStatusCalls.length, 0, 'setReportStatus must NOT be called when CRM update fails');
});

test('timeoutWatcher: after CRM recovers, next tick expires report and sends notification', async () => {
  const setStatusCalls = [];
  const notifications = [];
  let crmFails = true;

  const makeWatcher = () => createTimeoutWatcher({
    reportsStore: {
      async listOverdueReports() {
        // On second tick, simulate report still in overdue list (status unchanged)
        return [
          { id: 56, reportItemId: 9002, azsId: 'azs-10', slotKey: '2026-04-28:0900', status: 'in_progress' }
        ];
      },
      async setReportStatus({ reportId, status }) {
        setStatusCalls.push({ reportId, status });
      }
    },
    bitrixClient: {
      async updateReportItem() {
        if (crmFails) throw new Error('CRM_UNAVAILABLE');
      }
    },
    notificationService: {
      async notifyReportExpired(payload) {
        notifications.push(payload);
      }
    },
    settingsStore: {
      async read() {
        return {
          report: {
            entityTypeId: 163,
            stages: { expired: 'DT163_1:EXPIRED' }
          }
        };
      }
    },
    reviewerUserId: 42
  });

  // First tick: CRM fails → report not expired
  const watcher = makeWatcher();
  const summary1 = await watcher.runOnce();
  assert.equal(summary1.expired, 0, 'tick 1: no expiry when CRM fails');
  assert.equal(setStatusCalls.length, 0, 'tick 1: setReportStatus not called');

  // CRM recovers; second tick: should expire and notify
  crmFails = false;
  const summary2 = await watcher.runOnce();
  assert.equal(summary2.expired, 1, 'tick 2: report is expired after CRM recovers');
  assert.equal(setStatusCalls.length, 1, 'tick 2: setReportStatus called once');
  assert.deepEqual(setStatusCalls[0], { reportId: 56, status: 'expired' });
  assert.equal(notifications.length, 1, 'tick 2: notification sent after successful CRM+DB update');
});

// NOTIF-BOT-ONLY: notify-фоллбэк удалён — при сбое бот-добора timeoutWatcher НЕ
// пишет NOTIFY_FALLBACK_PREFIX-аннотацию (этого кода-пути больше нет). Доставка
// только ботом: при сбое алерт уходит админам внутри notificationService.
test('NOTIF-BOT-ONLY: timeoutWatcher при сбое бот-добора НЕ аннотирует dispatch_log notify-фоллбэком', async () => {
  const prevAppCode = process.env.BITRIX_APP_CODE;
  const appendErrorTextCalls = [];
  try {
    process.env.BITRIX_APP_CODE = 'local.azs.test789';

    const watcher = createTimeoutWatcher({
      reportsStore: {
        async listOverdueReports() {
          return [
            { id: 70, azsId: 'azs-7', adminUserId: 99, slotKey: '2026-06-01:1200', status: 'in_progress' }
          ];
        },
        async setReportStatus() {}
        // appendErrorText intentionally absent — removed from reportsStore (I-1 dedup)
      },
      dispatchLogStore: {
        async appendErrorText(payload) { appendErrorTextCalls.push(payload); }
      },
      bitrixClient: {
        async updateReportItem() {}
      },
      notificationService: {
        async notifyReportExpired() {},
        async notify() {
          // Bot-only: бот упал, без админов → undelivered (no notify fallback)
          return { delivered: false, channel: 'undelivered', botError: 'PARAM_KEYBOARD_ERROR' };
        }
      },
      settingsStore: {
        async read() {
          return {
            report: {
              entityTypeId: 163,
              stages: { expired: 'DT163_1:EXPIRED' }
            }
          };
        }
      },
      reasonStore: {
        async getByReport() { return null; }
      },
      reviewerUserId: 0
    });

    const summary = await watcher.runOnce();
    assert.equal(summary.expired, 1, 'отчёт должен быть просрочен');
    assert.equal(appendErrorTextCalls.length, 0, 'notify-фоллбэк-аннотации больше нет (bot-only)');
  } finally {
    if (prevAppCode === undefined) {
      delete process.env.BITRIX_APP_CODE;
    } else {
      process.env.BITRIX_APP_CODE = prevAppCode;
    }
  }
});
