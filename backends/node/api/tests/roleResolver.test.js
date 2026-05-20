import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES,
  normalizeAccessSettings,
  resolveUserRole,
  resolveAccessContext
} from '../src/access/roleResolver.js';

test('normalizeAccessSettings sanitizes role lists', () => {
  const normalized = normalizeAccessSettings({
    access: {
      adminUserIds: [1, '2', 2],
      reviewerUserIds: '3, 4, 4',
      azsAdminUserIds: ['7', 'bad', 8]
    }
  });

  assert.deepEqual(normalized.adminUserIds, [1, 2]);
  assert.deepEqual(normalized.reviewerUserIds, [3, 4]);
  assert.deepEqual(normalized.azsAdminUserIds, [7, 8]);
});

test('resolveUserRole applies priority admin > reviewer > azs_admin', () => {
  const role = resolveUserRole({
    userId: 11,
    isPortalAdmin: false,
    accessSettings: {
      adminUserIds: [10, 11],
      reviewerUserIds: [11, 12],
      azsAdminUserIds: [11, 13]
    }
  });

  assert.equal(role, ROLES.ADMIN);
});

test('resolveUserRole defaults portal admin to admin role', () => {
  const role = resolveUserRole({
    userId: 22,
    isPortalAdmin: true,
    accessSettings: {
      adminUserIds: [],
      reviewerUserIds: [],
      azsAdminUserIds: []
    }
  });

  assert.equal(role, ROLES.ADMIN);
});

test('resolveUserRole always treats user 498 as admin by default', () => {
  const role = resolveUserRole({
    userId: 498,
    isPortalAdmin: false,
    accessSettings: {
      adminUserIds: [],
      reviewerUserIds: [498],
      azsAdminUserIds: [498]
    }
  });

  assert.equal(role, ROLES.ADMIN);
});

test('resolveUserRole defaults regular users to azs_admin role', () => {
  const role = resolveUserRole({
    userId: 33,
    isPortalAdmin: false,
    accessSettings: {
      adminUserIds: [],
      reviewerUserIds: [],
      azsAdminUserIds: []
    }
  });

  assert.equal(role, ROLES.AZS_ADMIN);
});

test('resolveAccessContext returns capabilities by role', () => {
  const accessContext = resolveAccessContext({
    userId: 44,
    isPortalAdmin: false,
    settings: {
      access: {
        adminUserIds: [],
        reviewerUserIds: [44],
        azsAdminUserIds: []
      }
    }
  });

  assert.equal(accessContext.role, ROLES.REVIEWER);
  assert.deepEqual(accessContext.capabilities, {
    settings: false,
    reviewer: true,
    reports: false
  });
});
