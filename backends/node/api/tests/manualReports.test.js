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
