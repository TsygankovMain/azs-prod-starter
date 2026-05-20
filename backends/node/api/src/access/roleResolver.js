const ROLE_ADMIN = 'admin';
const ROLE_REVIEWER = 'reviewer';
const ROLE_AZS_ADMIN = 'azs_admin';
const SYSTEM_ADMIN_USER_IDS = [498];

const splitCsv = (value) => String(value || '')
  .split(/[,\n;]+/g)
  .map((item) => String(item || '').trim())
  .filter(Boolean);

const parseUserId = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const normalizeUserIdList = (value) => {
  const source = Array.isArray(value) ? value : splitCsv(value);
  return [...new Set(
    source
      .map(parseUserId)
      .filter((item) => item > 0)
  )];
};

const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const envAccessFallback = () => ({
  adminUserIds: normalizeUserIdList(process.env.ADMIN_USER_IDS),
  reviewerUserIds: normalizeUserIdList(process.env.REVIEWER_USER_IDS),
  azsAdminUserIds: normalizeUserIdList(process.env.AZS_ADMIN_USER_IDS)
});

export const normalizeAccessSettings = (settings = {}) => {
  const source = isPlainObject(settings) ? settings : {};
  const envFallback = envAccessFallback();
  const access = isPlainObject(source.access) ? source.access : {};

  return {
    adminUserIds: normalizeUserIdList(access.adminUserIds ?? envFallback.adminUserIds),
    reviewerUserIds: normalizeUserIdList(access.reviewerUserIds ?? envFallback.reviewerUserIds),
    azsAdminUserIds: normalizeUserIdList(access.azsAdminUserIds ?? envFallback.azsAdminUserIds)
  };
};

export const resolveUserRole = ({
  userId,
  isPortalAdmin = false,
  accessSettings = {}
}) => {
  const normalizedUserId = parseUserId(userId);
  const access = normalizeAccessSettings({ access: accessSettings });
  const hasId = (list) => list.includes(normalizedUserId);

  let role = ROLE_AZS_ADMIN;
  if (hasId(SYSTEM_ADMIN_USER_IDS)) {
    role = ROLE_ADMIN;
  } else if (hasId(access.adminUserIds)) {
    role = ROLE_ADMIN;
  } else if (hasId(access.reviewerUserIds)) {
    role = ROLE_REVIEWER;
  } else if (hasId(access.azsAdminUserIds)) {
    role = ROLE_AZS_ADMIN;
  } else if (isPortalAdmin) {
    role = ROLE_ADMIN;
  }

  return role;
};

export const getRoleCapabilities = (role) => {
  if (role === ROLE_ADMIN) {
    return {
      settings: true,
      reviewer: true,
      reports: true
    };
  }

  if (role === ROLE_REVIEWER) {
    return {
      settings: false,
      reviewer: true,
      reports: false
    };
  }

  return {
    settings: false,
    reviewer: false,
    reports: true
  };
};

export const resolveAccessContext = ({
  userId,
  isPortalAdmin = false,
  settings = {}
}) => {
  const access = normalizeAccessSettings(settings);
  const role = resolveUserRole({
    userId,
    isPortalAdmin,
    accessSettings: access
  });

  return {
    role,
    capabilities: getRoleCapabilities(role),
    access
  };
};

export const ROLES = Object.freeze({
  ADMIN: ROLE_ADMIN,
  REVIEWER: ROLE_REVIEWER,
  AZS_ADMIN: ROLE_AZS_ADMIN
});
