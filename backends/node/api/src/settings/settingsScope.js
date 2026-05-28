const normalizeDomain = (value) => String(value || '').trim().toLowerCase();
const normalizeMemberId = (value) => String(value || '').trim();

export const DEFAULT_SETTINGS_SCOPE = 'global';

export const resolveSettingsScope = (context = {}) => {
  const memberId = normalizeMemberId(context?.memberId || context?.member_id);
  const domain = normalizeDomain(context?.domain);
  if (!memberId || !domain) {
    return DEFAULT_SETTINGS_SCOPE;
  }
  return `${memberId}:${domain}`;
};

