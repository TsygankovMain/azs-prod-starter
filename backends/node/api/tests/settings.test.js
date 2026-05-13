import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  validateSettings
} from '../src/settings/defaultSettings.js';

test('mergeSettings overlays saved partial settings over defaults', () => {
  const merged = mergeSettings({
    azs: {
      entityTypeId: 179,
      fields: {
        admin: 'UF_CRM_AZS_ADMIN'
      }
    },
    report: {
      timeoutMinutes: 45
    }
  });

  assert.equal(merged.azs.entityTypeId, 179);
  assert.equal(merged.azs.fields.admin, 'UF_CRM_AZS_ADMIN');
  assert.equal(merged.azs.fields.reviewers, DEFAULT_SETTINGS.azs.fields.reviewers);
  assert.equal(merged.report.entityTypeId, DEFAULT_SETTINGS.report.entityTypeId);
  assert.equal(merged.report.timeoutMinutes, 45);
  assert.equal(merged.report.dispatchJitterMinutes, DEFAULT_SETTINGS.report.dispatchJitterMinutes);
  assert.deepEqual(merged.report.dispatchTimes, DEFAULT_SETTINGS.report.dispatchTimes);
  assert.deepEqual(merged.access.adminUserIds, DEFAULT_SETTINGS.access.adminUserIds);
});

test('validateSettings rejects invalid timeout and jitter ranges', () => {
  assert.throws(
    () => validateSettings(mergeSettings({ report: { timeoutMinutes: 0 } })),
    /report.timeoutMinutes must be greater than or equal to 1/
  );

  assert.throws(
    () => validateSettings(mergeSettings({ report: { dispatchJitterMinutes: -1 } })),
    /report.dispatchJitterMinutes must be greater than or equal to 0/
  );
});

test('validateSettings normalizes dispatch times from settings', () => {
  const normalized = validateSettings(mergeSettings({
    report: {
      dispatchTimes: ['18:45', '09:00', '18:45']
    }
  }));
  assert.deepEqual(normalized.report.dispatchTimes, ['09:00', '18:45']);
});

test('validateSettings normalizes access role user lists', () => {
  const normalized = validateSettings(mergeSettings({
    access: {
      adminUserIds: [1, 2, 2, 3],
      reviewerUserIds: [4, 5, 5],
      azsAdminUserIds: [6, 7, 7]
    }
  }));

  assert.deepEqual(normalized.access.adminUserIds, [1, 2, 3]);
  assert.deepEqual(normalized.access.reviewerUserIds, [4, 5]);
  assert.deepEqual(normalized.access.azsAdminUserIds, [6, 7]);
});

test('validateSettings rejects invalid access role lists', () => {
  assert.throws(
    () => validateSettings(mergeSettings({
      access: {
        adminUserIds: [1],
        reviewerUserIds: ['bad'],
        azsAdminUserIds: [3]
      }
    })),
    /access.reviewerUserIds contains invalid values/
  );
});

test('validateSettings requires report.fields.folderId when REST endpoint is configured', () => {
  const previous = process.env.BITRIX_REST_ENDPOINT;
  process.env.BITRIX_REST_ENDPOINT = 'https://example.bitrix24.ru/rest';

  try {
    assert.throws(
      () => validateSettings(mergeSettings({
        report: {
          fields: {
            folderId: ''
          }
        }
      })),
      /report.fields.folderId is required/
    );
  } finally {
    if (previous === undefined) {
      delete process.env.BITRIX_REST_ENDPOINT;
    } else {
      process.env.BITRIX_REST_ENDPOINT = previous;
    }
  }
});
