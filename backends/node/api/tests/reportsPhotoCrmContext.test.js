import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReportSlotKey,
  resolveAdminCrmSyncContext,
  resolveReportCrmAndDiskContexts
} from '../src/reports/reportsRoutes.js';
import { updateReportCrmItem } from '../src/reports/reportCrmSync.js';

test('parseReportSlotKey handles auto and manual slot keys', () => {
  assert.deepEqual(parseReportSlotKey('2026-05-28:1414'), {
    slotDate: '2026-05-28',
    slotHHmm: '1414'
  });
  assert.deepEqual(parseReportSlotKey('manual:2026-05-28:1414'), {
    slotDate: '2026-05-28',
    slotHHmm: '1414'
  });
});

test('parseReportSlotKey rejects malformed slot keys with typed config error', () => {
  assert.throws(
    () => parseReportSlotKey('legacy-slot'),
    (error) => error?.code === 'report_slot_key_invalid' && error?.statusCode === 422
  );
  assert.throws(
    () => parseReportSlotKey('2026-05-28:'),
    (error) => error?.code === 'report_slot_key_invalid' && error?.statusCode === 422
  );
  assert.throws(
    () => parseReportSlotKey('manual:2026-05-28:'),
    (error) => error?.code === 'report_slot_key_invalid' && error?.statusCode === 422
  );
});

test('photo flow CRM sync uses Bitrix portal-admin context (not current AZS user context)', async () => {
  const authContextStore = {
    async getLastAdminContext() {
      return {
        key: 'admin:ctx:key',
        context: {
          memberId: 'member-1',
          domain: 'example.bitrix24.ru',
          userId: 1,
          authId: 'admin-auth',
          refreshToken: 'admin-refresh',
          isAdmin: true
        }
      };
    }
  };

  const requestContext = {
    memberId: 'member-1',
    domain: 'example.bitrix24.ru',
    userId: 777,
    authId: 'user-auth',
    refreshToken: 'user-refresh',
    isAdmin: false
  };

  const crmContext = await resolveAdminCrmSyncContext({ authContextStore, requestContext });
  assert.ok(crmContext);
  assert.equal(crmContext.authId, 'admin-auth');
  assert.notEqual(crmContext.authId, requestContext.authId);

  const calls = [];
  const bitrixClient = {
    async updateReportItem(payload) {
      calls.push(payload);
      return { reportItemId: Number(payload.id), raw: {} };
    }
  };

  const settings = {
    report: {
      entityTypeId: 999,
      fields: { folderId: 'ufCrm999Folder' },
      stages: { inProgress: 'STAGE_IN_PROGRESS' }
    }
  };
  const report = { reportItemId: 123 };

  await updateReportCrmItem({
    bitrixClient,
    settings,
    report,
    status: 'in_progress',
    diskFolderId: 42,
    requireReportItem: true,
    context: crmContext
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.authId, 'admin-auth');
});

test('resolveAdminCrmSyncContext returns null when admin context is missing', async () => {
  const authContextStore = {
    async getLastAdminContext() {
      return null;
    }
  };
  const requestContext = { memberId: 'member-1', domain: 'example.bitrix24.ru' };

  const crmContext = await resolveAdminCrmSyncContext({ authContextStore, requestContext });
  assert.equal(crmContext, null);
});

test('resolveReportCrmAndDiskContexts uses current request context for Disk and portal-admin for CRM sync', async () => {
  const authContextStore = {
    async getLastAdminContext() {
      return {
        key: 'admin:ctx:key',
        context: {
          memberId: 'member-1',
          domain: 'example.bitrix24.ru',
          userId: 1,
          authId: 'admin-auth',
          refreshToken: 'admin-refresh',
          isAdmin: true
        }
      };
    }
  };

  const requestContext = {
    memberId: 'member-1',
    domain: 'example.bitrix24.ru',
    userId: 777,
    authId: 'user-auth',
    refreshToken: 'user-refresh',
    isAdmin: false
  };

  const { diskContext, crmSyncContext } = await resolveReportCrmAndDiskContexts({ authContextStore, requestContext });
  assert.equal(diskContext, requestContext);
  assert.equal(crmSyncContext.authId, 'admin-auth');
  assert.notEqual(crmSyncContext.authId, diskContext.authId);
});

test('resolveReportCrmAndDiskContexts throws admin_context_missing when admin context is missing', async () => {
  const authContextStore = {
    async getLastAdminContext() {
      return null;
    }
  };
  const requestContext = { memberId: 'member-1', domain: 'example.bitrix24.ru' };

  await assert.rejects(
    () => resolveReportCrmAndDiskContexts({ authContextStore, requestContext }),
    (error) => error?.code === 'admin_context_missing' && error?.statusCode === 502
  );
});

test('resolveAdminCrmSyncContext requires current request portal identity', async () => {
  const authContextStore = {
    async getLastAdminContext() {
      return {
        key: 'admin:ctx:key',
        context: {
          memberId: 'member-1',
          domain: 'example.bitrix24.ru',
          userId: 1,
          authId: 'admin-auth',
          refreshToken: 'admin-refresh',
          isAdmin: true
        }
      };
    }
  };

  const crmContext = await resolveAdminCrmSyncContext({
    authContextStore,
    requestContext: {}
  });
  assert.equal(crmContext, null);
});

test('resolveAdminCrmSyncContext returns null when admin context belongs to another portal', async () => {
  const authContextStore = {
    async getLastAdminContext() {
      return {
        key: 'admin:other',
        context: {
          memberId: 'member-2',
          domain: 'other.bitrix24.ru',
          userId: 1,
          authId: 'admin-auth',
          refreshToken: 'admin-refresh',
          isAdmin: true
        }
      };
    }
  };
  const requestContext = { memberId: 'member-1', domain: 'example.bitrix24.ru' };

  const crmContext = await resolveAdminCrmSyncContext({ authContextStore, requestContext });
  assert.equal(crmContext, null);
});
