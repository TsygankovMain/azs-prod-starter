const PLACEMENTS = [
  {
    code: 'REST_APP_URI',
    title: 'Фото-отчёт АЗС',
    description: 'Открытие отчёта АЗС по ссылке из уведомления',
    en: { title: 'AZS Photo Report', description: 'Open AZS photo report from bot link' }
  },
  {
    code: 'IMMOBILE_CONTEXT_MENU',
    title: 'Порядок на АЗС',
    description: 'Открыть интерфейс управляющего АЗС',
    en: { title: 'AZS Order', description: 'Open AZS reviewer interface' }
  }
];

const bindOne = async ({ bitrixClient, authId, context, handlerUrl, p }) => {
  await bitrixClient.callMethodWithAuth('placement.bind', {
    PLACEMENT: p.code,
    HANDLER: handlerUrl,
    TITLE: p.title,
    DESCRIPTION: p.description,
    LANG_ALL: {
      ru: { TITLE: p.title, DESCRIPTION: p.description, GROUP_NAME: '' },
      en: { TITLE: p.en.title, DESCRIPTION: p.en.description, GROUP_NAME: '' }
    }
  }, authId, context).catch(async (error) => {
    if (!String(error?.message || '').includes('ERROR_PLACEMENT_MAX_COUNT')) throw error;
    const after = await bitrixClient.callMethodWithAuth('placement.get', {}, authId, context);
    const list = Array.isArray(after) ? after : [];
    if (!list.find((row) => String(row?.placement || '').trim() === p.code)) throw error;
  });
};

export const ensureAppPlacements = async ({ bitrixClient, authId, context, handlerUrl }) => {
  if (!authId) throw new Error('AUTH_ID is required to bind placements');
  if (!handlerUrl) throw new Error('APP_BASE_URL or VIRTUAL_HOST is required to bind placements');
  const placements = await bitrixClient.callMethodWithAuth('placement.get', {}, authId, context);
  const existing = new Set((Array.isArray(placements) ? placements : []).map((r) => String(r?.placement || '').trim()));
  const results = [];
  for (const p of PLACEMENTS) {
    if (existing.has(p.code)) { results.push({ code: p.code, alreadyExists: true }); continue; }
    await bindOne({ bitrixClient, authId, context, handlerUrl, p });
    results.push({ code: p.code, alreadyExists: false });
  }
  return { bound: true, handler: handlerUrl, placements: results };
};

export default ensureAppPlacements;
