/**
 * Резолвер id бота для notificationService, сторожа очереди фото и
 * diagChatNotifier.
 *
 * Фоновые задачи (рассылка заданий, сторож) работают в контексте входящего
 * вебхука — в нём нет authId, а реестр ботов (imbot.v2.Bot.list) требует
 * OAuth. Раньше резолвер в этом случае сразу отдавал 0, и после перезапуска
 * процесса бот «не существовал», пока в приложение не зайдёт администратор:
 * 06.10.2026 утренние задания 69 станциям ушли без сообщения от бота.
 *
 * Порядок теперь такой:
 *   1. в контексте есть authId — спрашиваем реестр под ним (как раньше);
 *   2. authId нет — берём id, уже известный процессу (его выставляют
 *      /api/install, /api/admin/bot/reregister и notificationService);
 *   3. и его нет — берём последний сохранённый контекст администратора
 *      и спрашиваем реестр под ним.
 */
const readAuthId = (context = {}) => String(context?.authId || context?.auth_id || '').trim();

export const createBotIdResolver = ({
  botRegistryService,
  getAdminContext = null,
  getKnownBotId = () => Number(process.env.BITRIX_BOT_ID || 0),
  logger = console
}) => async (context = {}) => {
  const authId = readAuthId(context);
  if (authId) {
    const registration = await botRegistryService.ensureBot({ authId, context });
    return registration.botId;
  }

  const knownBotId = Number(getKnownBotId());
  if (Number.isFinite(knownBotId) && knownBotId > 0) {
    return Math.floor(knownBotId);
  }

  if (typeof getAdminContext !== 'function') {
    return 0;
  }
  const adminContext = await getAdminContext().catch((error) => {
    logger.warn('bot id resolve: admin context unavailable', { message: error.message });
    return {};
  });
  const adminAuthId = readAuthId(adminContext);
  if (!adminAuthId) {
    return 0;
  }
  const registration = await botRegistryService.ensureBot({ authId: adminAuthId, context: adminContext });
  return registration.botId;
};

export default createBotIdResolver;
