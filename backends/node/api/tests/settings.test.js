import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
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

test('validateSettings requires report.fields.folderId when Bitrix sync is required without portal hardcode', () => {
  const previous = process.env.BITRIX_SYNC_REQUIRED;
  process.env.BITRIX_SYNC_REQUIRED = 'true';

  try {
    assert.throws(
      () => validateSettings(mergeSettings({
        report: {
          fields: {
            folderId: ''
          }
        }
      })),
      /report.fields.folderId is required when Bitrix sync is enabled/
    );
  } finally {
    if (previous === undefined) {
      delete process.env.BITRIX_SYNC_REQUIRED;
    } else {
      process.env.BITRIX_SYNC_REQUIRED = previous;
    }
  }
});

test('normalizeSettings can load incomplete settings while Bitrix sync is required', () => {
  const previous = process.env.BITRIX_SYNC_REQUIRED;
  process.env.BITRIX_SYNC_REQUIRED = 'true';

  try {
    const normalized = normalizeSettings({}, { requireBitrixSyncFields: false });
    assert.equal(normalized.report.fields.folderId, '');
  } finally {
    if (previous === undefined) {
      delete process.env.BITRIX_SYNC_REQUIRED;
    } else {
      process.env.BITRIX_SYNC_REQUIRED = previous;
    }
  }
});

test('validateSettings accepts valid report.workWindow', () => {
  const normalized = validateSettings(mergeSettings({
    report: {
      workWindow: { start: '07:00', end: '22:00' }
    }
  }));
  assert.deepEqual(normalized.report.workWindow, { start: '07:00', end: '22:00' });
});

test('validateSettings rejects workWindow where start >= end (start after end)', () => {
  assert.throws(
    () => validateSettings(mergeSettings({
      report: {
        workWindow: { start: '22:00', end: '07:00' }
      }
    })),
    /report\.workWindow\.start must be earlier than report\.workWindow\.end/
  );
});

test('validateSettings rejects workWindow where start equals end', () => {
  assert.throws(
    () => validateSettings(mergeSettings({
      report: {
        workWindow: { start: '08:00', end: '08:00' }
      }
    })),
    /report\.workWindow\.start must be earlier than report\.workWindow\.end/
  );
});

test('validateSettings rejects workWindow with malformed time string', () => {
  assert.throws(
    () => validateSettings(mergeSettings({
      report: {
        workWindow: { start: '7', end: '22:00' }
      }
    })),
    /report\.workWindow start and end must match HH:mm/
  );
});

test('normalizeSettings uses default workWindow when absent from saved settings', () => {
  const normalized = normalizeSettings({});
  assert.deepEqual(normalized.report.workWindow, DEFAULT_SETTINGS.report.workWindow);
  assert.deepEqual(normalized.report.workWindow, { start: '07:00', end: '22:00' });
});

// ─── azs.fields.manager ───────────────────────────────────────────────────────

test('DEFAULT_SETTINGS includes azs.fields.manager as empty string', () => {
  assert.equal(DEFAULT_SETTINGS.azs.fields.manager, '');
});

test('mergeSettings preserves azs.fields.manager from saved settings', () => {
  const merged = mergeSettings({ azs: { fields: { manager: 'UF_CRM_AZS_MANAGER' } } });
  assert.equal(merged.azs.fields.manager, 'UF_CRM_AZS_MANAGER');
});

test('mergeSettings defaults azs.fields.manager to empty string when absent', () => {
  const merged = mergeSettings({ azs: { entityTypeId: 42 } });
  assert.equal(merged.azs.fields.manager, '');
});

test('validateSettings passes through azs.fields.manager unchanged', () => {
  const normalized = validateSettings(mergeSettings({
    azs: { fields: { manager: 'UF_CRM_AZS_MGR' } }
  }));
  assert.equal(normalized.azs.fields.manager, 'UF_CRM_AZS_MGR');
});

// ─── photoFeed.remarkTemplates ────────────────────────────────────────────────

test('DEFAULT_SETTINGS includes photoFeed.remarkTemplates with two seed entries', () => {
  assert.ok(Array.isArray(DEFAULT_SETTINGS.photoFeed.remarkTemplates));
  assert.equal(DEFAULT_SETTINGS.photoFeed.remarkTemplates.length, 2);
  assert.ok(DEFAULT_SETTINGS.photoFeed.remarkTemplates.every((t) => typeof t === 'string' && t.trim()));
});

test('normalizeSettings uses default photoFeed.remarkTemplates when absent', () => {
  const normalized = normalizeSettings({});
  assert.deepEqual(normalized.photoFeed.remarkTemplates, DEFAULT_SETTINGS.photoFeed.remarkTemplates);
});

test('normalizeSettings preserves custom photoFeed.remarkTemplates', () => {
  const templates = ['Шаблон 1', 'Шаблон 2'];
  const normalized = normalizeSettings({ photoFeed: { remarkTemplates: templates } });
  assert.deepEqual(normalized.photoFeed.remarkTemplates, templates);
});

test('validateSettings rejects photoFeed.remarkTemplates that is not an array', () => {
  assert.throws(
    () => validateSettings(mergeSettings({ photoFeed: { remarkTemplates: 'bad' } })),
    /photoFeed\.remarkTemplates must be an array/
  );
});

test('validateSettings rejects photoFeed.remarkTemplates with more than 10 items', () => {
  const tooMany = Array.from({ length: 11 }, (_, i) => `Шаблон ${i + 1}`);
  assert.throws(
    () => validateSettings(mergeSettings({ photoFeed: { remarkTemplates: tooMany } })),
    /photoFeed\.remarkTemplates must contain at most 10 items/
  );
});

test('validateSettings rejects photoFeed.remarkTemplates with empty string item', () => {
  assert.throws(
    () => validateSettings(mergeSettings({ photoFeed: { remarkTemplates: ['OK', ''] } })),
    /photoFeed\.remarkTemplates items must be non-empty strings/
  );
});

test('validateSettings rejects photoFeed.remarkTemplates item exceeding 200 characters', () => {
  const longTemplate = 'А'.repeat(201);
  assert.throws(
    () => validateSettings(mergeSettings({ photoFeed: { remarkTemplates: [longTemplate] } })),
    /photoFeed\.remarkTemplates items must be non-empty strings of at most 200 characters/
  );
});

test('validateSettings rejects photoFeed when it is not an object', () => {
  assert.throws(
    () => validateSettings(mergeSettings({ photoFeed: 'bad' })),
    /photoFeed must be an object/
  );
});

test('normalizeSettings trims whitespace from photoFeed.remarkTemplates items', () => {
  const normalized = normalizeSettings({ photoFeed: { remarkTemplates: ['  Шаблон  '] } });
  assert.deepEqual(normalized.photoFeed.remarkTemplates, ['Шаблон']);
});
