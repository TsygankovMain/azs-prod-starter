/**
 * azsRecipients — shared recipient resolution for the photo-feed/remark features.
 *
 * resolveAzsRecipients({ azsId, settings, bitrixClient, context })
 *   → { manager: {id, name} | null, admin: {id, name} | null }
 *
 * azsId may be a numeric string or CRM item reference ("CRM_SMART_PROCESS_ITEM_145_42").
 */

const parseCrmItemId = (value) => {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  const match = String(value || '').match(/(\d+)$/);
  const parsed = Number(match?.[1] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const getFieldValue = (item, fieldCode) => {
  if (!item || !fieldCode) return undefined;
  const code = String(fieldCode).trim();
  const aliases = [code, code.toLowerCase(), code.toUpperCase()];
  const underscoreMatch = code.match(/^UF_CRM_(\d+)_(\d+)$/i);
  if (underscoreMatch) aliases.push(`ufCrm${underscoreMatch[1]}_${underscoreMatch[2]}`);
  const camelMatch = code.match(/^ufCrm(\d+)_(\d+)$/i);
  if (camelMatch) aliases.push(`UF_CRM_${camelMatch[1]}_${camelMatch[2]}`);
  for (const alias of aliases) {
    if (alias && alias in item && item[alias] !== undefined && item[alias] !== null) {
      return item[alias];
    }
  }
  return undefined;
};

const extractMultipleIds = (value) => {
  if (Array.isArray(value)) return value.flatMap(extractMultipleIds);
  if (value && typeof value === 'object') {
    return extractMultipleIds(value.id ?? value.ID ?? value.value ?? value.VALUE);
  }
  const id = parseCrmItemId(value);
  return id ? [id] : [];
};

const extractFirstUserId = (value) => {
  const ids = extractMultipleIds(value);
  return ids.length ? Number(ids[0]) : 0;
};

const resolveUserName = async (bitrixClient, userId, context = {}) => {
  try {
    if (typeof bitrixClient.callMethod !== 'function') return null;
    const result = await bitrixClient.callMethod('user.get', { ID: userId }, context);
    const users = Array.isArray(result) ? result
      : Array.isArray(result?.result) ? result.result : [];
    const user = users[0];
    if (!user) return null;
    const name = [
      String(user.NAME || '').trim(),
      String(user.LAST_NAME || '').trim()
    ].filter(Boolean).join(' ');
    return name || null;
  } catch {
    return null;
  }
};

/**
 * resolveAzsRecipients
 *
 * @param {object} params
 * @param {string} params.azsId   — CRM item id (numeric string or reference)
 * @param {object} params.settings — app settings (needs settings.azs.entityTypeId, .fields.manager, .fields.admin)
 * @param {object} params.bitrixClient
 * @param {object} [params.context] — Bitrix auth context (admin context recommended)
 * @returns {Promise<{manager: {id:number,name:string|null}|null, admin: {id:number,name:string|null}|null}>}
 */
export const resolveAzsRecipients = async ({
  azsId,
  settings,
  bitrixClient,
  context = {}
}) => {
  const azsItemId = parseCrmItemId(azsId);
  if (!azsItemId) return { manager: null, admin: null };

  const azsEntityTypeId = Number(settings?.azs?.entityTypeId || 0);
  if (!azsEntityTypeId) return { manager: null, admin: null };

  let azsItem = null;
  try {
    azsItem = await bitrixClient.getCrmItem({
      entityTypeId: azsEntityTypeId,
      id: azsItemId,
      context
    });
  } catch {
    // best-effort
  }

  if (!azsItem) return { manager: null, admin: null };

  // ----- manager -----
  let manager = null;
  const managerFieldCode = String(settings?.azs?.fields?.manager || '').trim();
  if (managerFieldCode) {
    const managerUserId = extractFirstUserId(getFieldValue(azsItem, managerFieldCode));
    if (managerUserId > 0) {
      const managerName = await resolveUserName(bitrixClient, managerUserId, context);
      manager = { id: managerUserId, name: managerName };
    }
  }

  // ----- admin -----
  let admin = null;
  const adminFieldCode = String(settings?.azs?.fields?.admin || '').trim();
  if (adminFieldCode) {
    const adminUserId = extractFirstUserId(getFieldValue(azsItem, adminFieldCode));
    if (adminUserId > 0) {
      const adminName = await resolveUserName(bitrixClient, adminUserId, context);
      admin = { id: adminUserId, name: adminName };
    }
  }

  return { manager, admin };
};

export default resolveAzsRecipients;
