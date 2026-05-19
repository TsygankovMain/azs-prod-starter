const normalizeAuthId = (value) => String(value || '').trim();

const parseBotId = (payload) => {
  const id = Number(
    payload?.id
    ?? payload?.ID
    ?? payload?.botId
    ?? payload?.BOT_ID
    ?? payload?.bot?.id
    ?? 0
  );
  return Number.isFinite(id) && id > 0 ? Math.floor(id) : 0;
};

export const createBotRegistryService = ({
  bitrixClient,
  logger = console,
  botCode = process.env.BITRIX_BOT_CODE || 'azs_order_bot',
  botName = process.env.BITRIX_BOT_NAME || 'Порядок на АЗС',
  botWorkPosition = process.env.BITRIX_BOT_WORK_POSITION || 'Фото-отчёты АЗС'
}) => {
  if (!bitrixClient || typeof bitrixClient.callMethodWithAuth !== 'function') {
    throw new Error('bitrixClient.callMethodWithAuth is required');
  }

  const registerBot = async ({ authId = '', context = {} } = {}) => {
    const runtimeAuthId = normalizeAuthId(authId);
    if (!runtimeAuthId) {
      throw new Error('AUTH_ID is required to register bot during install');
    }

    const result = await bitrixClient.callMethodWithAuth('imbot.v2.Bot.register', {
      fields: {
        code: String(botCode).trim(),
        properties: {
          name: String(botName).trim(),
          workPosition: String(botWorkPosition).trim()
        },
        type: 'bot',
        eventMode: 'fetch'
      }
    }, runtimeAuthId, context);

    const botId = parseBotId(result);
    if (!botId) {
      throw new Error('imbot.v2.Bot.register response does not include bot id');
    }

    logger.info('bot registered', { botId, botCode });
    return {
      botId,
      raw: result
    };
  };

  const listBots = async ({ authId = '', context = {} } = {}) => {
    const runtimeAuthId = normalizeAuthId(authId);
    if (!runtimeAuthId) {
      throw new Error('AUTH_ID is required to list bots during install');
    }

    const result = await bitrixClient.callMethodWithAuth('imbot.v2.Bot.list', {
      filter: {
        type: 'bot'
      },
      limit: 50
    }, runtimeAuthId, context);

    const bots = Array.isArray(result?.bots) ? result.bots : [];
    return bots.map((bot) => ({
      id: parseBotId(bot),
      code: String(bot?.code || ''),
      type: String(bot?.type || ''),
      raw: bot
    }));
  };

  const ensureBot = async ({ authId = '', context = {} } = {}) => {
    const runtimeAuthId = normalizeAuthId(authId);
    if (!runtimeAuthId) {
      throw new Error('AUTH_ID is required to ensure bot during install');
    }

    const expectedCode = String(botCode || '').trim();
    const existingBots = await listBots({ authId: runtimeAuthId, context }).catch((error) => {
      logger.warn('bot list failed before registration', { error: error.message });
      return [];
    });
    const existing = existingBots.find((bot) => bot.id && bot.code === expectedCode);
    if (existing) {
      logger.info('bot reused', { botId: existing.id, botCode: expectedCode });
      return {
        botId: existing.id,
        reused: true,
        registered: false,
        bots: existingBots,
        raw: existing.raw
      };
    }

    const registration = await registerBot({ authId: runtimeAuthId, context });
    const botsAfterRegistration = await listBots({ authId: runtimeAuthId, context }).catch(() => []);
    return {
      ...registration,
      reused: false,
      registered: true,
      bots: botsAfterRegistration
    };
  };

  return {
    registerBot,
    listBots,
    ensureBot
  };
};

export default createBotRegistryService;
