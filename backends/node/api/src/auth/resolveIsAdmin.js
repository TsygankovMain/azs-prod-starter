/**
 * Parses a loosely-typed boolean from Bitrix / request fields.
 * Recognises '1', 'y', 'yes', 'true' (case-insensitive) as true.
 * Identical semantics to parseBoolean() in server.js.
 *
 * Exported for use in tests and for server.js to import.
 */
export const parseBoolean = (value) => {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'y' || raw === 'yes' || raw === 'true';
};

/**
 * Resolves the `isAdmin` flag for a getToken request.
 *
 * Target invariant (BUG-A1):
 *   - profile.ADMIN present (non-null, non-empty-string) → authoritative source
 *     of truth. Bitrix may both promote AND legitimately demote.
 *   - profile.ADMIN absent/null/'' → NEVER lower isAdmin below the already-stored
 *     value. Elevation (false→true) is still allowed when the request body says
 *     admin=Y; demotion (true→false from a stale body) is forbidden.
 *
 * @param {object} params
 * @param {unknown} params.profileAdminRaw   - profile.ADMIN from Bitrix API (may be undefined/null/'')
 * @param {unknown} params.requestAdminRaw   - is_admin / IS_ADMIN / admin from request body (may be undefined)
 * @param {boolean} params.previousIsAdmin   - isAdmin value stored in authContextStore for this user
 * @returns {boolean}
 */
export const resolveIsAdmin = ({ profileAdminRaw, requestAdminRaw, previousIsAdmin }) => {
  // Bitrix profile.ADMIN is authoritative when explicitly present.
  if (profileAdminRaw !== undefined && profileAdminRaw !== null && profileAdminRaw !== '') {
    return parseBoolean(profileAdminRaw);
  }

  // profile.ADMIN is absent: honour the previously stored admin elevation.
  // If previousIsAdmin is already true, keep it regardless of requestAdminRaw
  // (stale body must not demote a portal admin).
  // If previousIsAdmin is false, allow the request body to elevate (but not
  // to demote further below false — false is the floor).
  if (previousIsAdmin) {
    return true;
  }

  // previousIsAdmin is false: requestAdminRaw may elevate to true.
  if (requestAdminRaw === undefined) {
    return false;
  }
  return parseBoolean(requestAdminRaw);
};
