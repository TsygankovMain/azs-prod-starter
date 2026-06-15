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

test('resolveUserRole gives admin to userId 498 when in adminUserIds list', () => {
  // 498 is no longer a hardcoded super-admin; it gets admin only when listed.
  const role = resolveUserRole({
    userId: 498,
    isPortalAdmin: false,
    accessSettings: {
      adminUserIds: [498],
      reviewerUserIds: [],
      azsAdminUserIds: []
    }
  });

  assert.equal(role, ROLES.ADMIN);
});

// --- BUG-A2: env-driven SYSTEM_ADMIN_USER_IDS, not hardcoded 498 ---

test('resolveUserRole (BUG-A2): portal admin userId 999 gets admin role even with all lists empty', () => {
  const savedEnv = process.env.SYSTEM_ADMIN_USER_IDS;
  delete process.env.SYSTEM_ADMIN_USER_IDS;

  try {
    const role = resolveUserRole({
      userId: 999,
      isPortalAdmin: true,
      accessSettings: { adminUserIds: [], reviewerUserIds: [], azsAdminUserIds: [] }
    });
    assert.equal(role, ROLES.ADMIN);
  } finally {
    if (savedEnv !== undefined) {
      process.env.SYSTEM_ADMIN_USER_IDS = savedEnv;
    }
  }
});

test('resolveUserRole (BUG-A2): SYSTEM_ADMIN_USER_IDS=777 grants admin to userId 777 without isPortalAdmin', () => {
  const savedEnv = process.env.SYSTEM_ADMIN_USER_IDS;
  process.env.SYSTEM_ADMIN_USER_IDS = '777';

  try {
    const role = resolveUserRole({
      userId: 777,
      isPortalAdmin: false,
      accessSettings: { adminUserIds: [], reviewerUserIds: [], azsAdminUserIds: [] }
    });
    assert.equal(role, ROLES.ADMIN);
  } finally {
    if (savedEnv !== undefined) {
      process.env.SYSTEM_ADMIN_USER_IDS = savedEnv;
    } else {
      delete process.env.SYSTEM_ADMIN_USER_IDS;
    }
  }
});

test('resolveUserRole (BUG-A2): userId 498 is NOT special when SYSTEM_ADMIN_USER_IDS is unset', () => {
  const savedEnv = process.env.SYSTEM_ADMIN_USER_IDS;
  delete process.env.SYSTEM_ADMIN_USER_IDS;

  try {
    const role = resolveUserRole({
      userId: 498,
      isPortalAdmin: false,
      accessSettings: { adminUserIds: [], reviewerUserIds: [], azsAdminUserIds: [] }
    });
    // 498 must no longer be a hardcoded super-admin; falls through to default azs_admin
    assert.equal(role, ROLES.AZS_ADMIN);
  } finally {
    if (savedEnv !== undefined) {
      process.env.SYSTEM_ADMIN_USER_IDS = savedEnv;
    }
  }
});

test('resolveUserRole (BUG-A2): SYSTEM_ADMIN_USER_IDS takes precedence over reviewer role', () => {
  const savedEnv = process.env.SYSTEM_ADMIN_USER_IDS;
  process.env.SYSTEM_ADMIN_USER_IDS = '777';

  try {
    const role = resolveUserRole({
      userId: 777,
      isPortalAdmin: false,
      accessSettings: { adminUserIds: [], reviewerUserIds: [777], azsAdminUserIds: [] }
    });
    // 777 is in SYSTEM_ADMIN_USER_IDS; must resolve to admin role, not reviewer
    assert.equal(role, ROLES.ADMIN);
  } finally {
    if (savedEnv !== undefined) {
      process.env.SYSTEM_ADMIN_USER_IDS = savedEnv;
    } else {
      delete process.env.SYSTEM_ADMIN_USER_IDS;
    }
  }
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

// --- BUG-A7: портал-админ всегда получает роль admin, независимо от списков ---

test('resolveUserRole (BUG-A7-A): портал-админ в reviewerUserIds получает admin, а не reviewer', () => {
  // Тест A (главный): isPortalAdmin:true, userId 498, reviewerUserIds:[498], env пусто → admin
  const savedEnv = process.env.SYSTEM_ADMIN_USER_IDS;
  delete process.env.SYSTEM_ADMIN_USER_IDS;

  try {
    const role = resolveUserRole({
      userId: 498,
      isPortalAdmin: true,
      accessSettings: {
        adminUserIds: [],
        reviewerUserIds: [498],
        azsAdminUserIds: []
      }
    });
    assert.equal(role, ROLES.ADMIN);
  } finally {
    if (savedEnv !== undefined) {
      process.env.SYSTEM_ADMIN_USER_IDS = savedEnv;
    }
  }
});

test('resolveUserRole (BUG-A7-B): портал-админ в azsAdminUserIds получает admin', () => {
  const savedEnv = process.env.SYSTEM_ADMIN_USER_IDS;
  delete process.env.SYSTEM_ADMIN_USER_IDS;

  try {
    const role = resolveUserRole({
      userId: 100,
      isPortalAdmin: true,
      accessSettings: {
        adminUserIds: [],
        reviewerUserIds: [],
        azsAdminUserIds: [100]
      }
    });
    assert.equal(role, ROLES.ADMIN);
  } finally {
    if (savedEnv !== undefined) {
      process.env.SYSTEM_ADMIN_USER_IDS = savedEnv;
    }
  }
});

test('resolveUserRole (BUG-A7-regress-1): НЕ портал-админ в reviewerUserIds остаётся reviewer', () => {
  const savedEnv = process.env.SYSTEM_ADMIN_USER_IDS;
  delete process.env.SYSTEM_ADMIN_USER_IDS;

  try {
    const role = resolveUserRole({
      userId: 55,
      isPortalAdmin: false,
      accessSettings: {
        adminUserIds: [],
        reviewerUserIds: [55],
        azsAdminUserIds: []
      }
    });
    assert.equal(role, ROLES.REVIEWER);
  } finally {
    if (savedEnv !== undefined) {
      process.env.SYSTEM_ADMIN_USER_IDS = savedEnv;
    }
  }
});

test('resolveUserRole (BUG-A7-regress-2): портал-админ при пустых списках получает admin', () => {
  const savedEnv = process.env.SYSTEM_ADMIN_USER_IDS;
  delete process.env.SYSTEM_ADMIN_USER_IDS;

  try {
    const role = resolveUserRole({
      userId: 200,
      isPortalAdmin: true,
      accessSettings: {
        adminUserIds: [],
        reviewerUserIds: [],
        azsAdminUserIds: []
      }
    });
    assert.equal(role, ROLES.ADMIN);
  } finally {
    if (savedEnv !== undefined) {
      process.env.SYSTEM_ADMIN_USER_IDS = savedEnv;
    }
  }
});

test('resolveUserRole (BUG-A7-regress-3a): systemAdminUserIds даёт admin независимо от isPortalAdmin', () => {
  const savedEnv = process.env.SYSTEM_ADMIN_USER_IDS;
  process.env.SYSTEM_ADMIN_USER_IDS = '300';

  try {
    const role = resolveUserRole({
      userId: 300,
      isPortalAdmin: false,
      accessSettings: {
        adminUserIds: [],
        reviewerUserIds: [],
        azsAdminUserIds: []
      }
    });
    assert.equal(role, ROLES.ADMIN);
  } finally {
    if (savedEnv !== undefined) {
      process.env.SYSTEM_ADMIN_USER_IDS = savedEnv;
    } else {
      delete process.env.SYSTEM_ADMIN_USER_IDS;
    }
  }
});

test('resolveUserRole (BUG-A7-regress-3b): adminUserIds даёт admin независимо от isPortalAdmin', () => {
  const savedEnv = process.env.SYSTEM_ADMIN_USER_IDS;
  delete process.env.SYSTEM_ADMIN_USER_IDS;

  try {
    const role = resolveUserRole({
      userId: 400,
      isPortalAdmin: false,
      accessSettings: {
        adminUserIds: [400],
        reviewerUserIds: [],
        azsAdminUserIds: []
      }
    });
    assert.equal(role, ROLES.ADMIN);
  } finally {
    if (savedEnv !== undefined) {
      process.env.SYSTEM_ADMIN_USER_IDS = savedEnv;
    }
  }
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
