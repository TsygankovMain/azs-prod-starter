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
      },
      async notifyUser(payload) {
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
      },
      async notifyUser() {}
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
    }
  }]);
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
    reviewerUserId: 11
  });

  const summary = await watcher.runOnce();
  assert.equal(summary.total, 1);
  assert.equal(summary.expired, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.notified, 0);
});
