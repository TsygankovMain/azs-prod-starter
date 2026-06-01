import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveManualCandidates } from '../src/reports/reportsRoutes.js';

const settings = {
  azs: {
    entityTypeId: 111,
    fields: {
      admin: 'UF_ADMIN'
    }
  },
  report: {
    entityTypeId: 222
  }
};

test('resolveManualCandidates rejects empty manual launch payload with details', async () => {
  await assert.rejects(
    () => resolveManualCandidates({
      payload: {},
      settings,
      bitrixClient: {
        async getCrmItem() {
          return null;
        }
      }
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'manual_report_validation_failed');
      assert.deepEqual(error.details, [
        'Выберите хотя бы одну АЗС',
        'Укажите дату запуска',
        'Укажите время запуска'
      ]);
      return true;
    }
  );
});

test('resolveManualCandidates reads admin user when Bitrix returns the field in camelCase', async () => {
  // Bitrix with useOriginalUfNames:N returns UF fields camelCased (ufCrm2_123),
  // while settings store the original UF_CRM_2_123 code. The field reader must
  // match across both forms or adminUserId silently resolves to 0.
  const camelSettings = {
    azs: { entityTypeId: 111, fields: { admin: 'UF_CRM_2_123' } },
    report: { entityTypeId: 222 }
  };
  const result = await resolveManualCandidates({
    payload: { azsIds: ['5042'], slotDate: '2026-05-04', slotHHmm: '1845' },
    settings: camelSettings,
    bitrixClient: {
      async getCrmItem({ id }) {
        return { id, ufCrm2_123: 77 };
      }
    }
  });

  assert.deepEqual(result.failedItems, []);
  assert.deepEqual(result.candidates, [
    { azsId: '5042', adminUserId: 77, slotDate: '2026-05-04', slotHHmm: '1845' }
  ]);
});

test('resolveManualCandidates falls back to the requesting reviewer when AZS has no admin', async () => {
  const result = await resolveManualCandidates({
    payload: { azsIds: ['5042'], slotDate: '2026-05-04', slotHHmm: '1845' },
    settings,
    bitrixClient: {
      async getCrmItem() {
        return { id: 5042, UF_ADMIN: 0 }; // no admin on the card
      }
    },
    fallbackUserId: 498
  });

  assert.deepEqual(result.failedItems, []);
  assert.deepEqual(result.candidates, [
    { azsId: '5042', adminUserId: 498, slotDate: '2026-05-04', slotHHmm: '1845' }
  ]);
});

test('resolveManualCandidates still fails the item when no admin and no fallback', async () => {
  // When every candidate fails (no successful ones), the helper throws a 400
  // with the per-item reasons in details — it does not return failedItems.
  await assert.rejects(
    () => resolveManualCandidates({
      payload: { azsIds: ['5042'], slotDate: '2026-05-04', slotHHmm: '1845' },
      settings,
      bitrixClient: {
        async getCrmItem() {
          return { id: 5042, UF_ADMIN: 0 };
        }
      }
      // no fallbackUserId
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.details.some((d) => /не указан администратор/.test(d)));
      return true;
    }
  );
});

test('resolveManualCandidates resolves admin user from AZS card for multiple items', async () => {
  const result = await resolveManualCandidates({
    payload: {
      azsIds: ['101', '102'],
      slotDate: '2026-05-04',
      slotHHmm: '1845'
    },
    settings,
    bitrixClient: {
      async getCrmItem({ id }) {
        return {
          id,
          UF_ADMIN: id === 101 ? 11 : 12
        };
      }
    }
  });

  assert.deepEqual(result.failedItems, []);
  assert.deepEqual(result.candidates, [
    {
      azsId: '101',
      adminUserId: 11,
      slotDate: '2026-05-04',
      slotHHmm: '1845'
    },
    {
      azsId: '102',
      adminUserId: 12,
      slotDate: '2026-05-04',
      slotHHmm: '1845'
    }
  ]);
});
