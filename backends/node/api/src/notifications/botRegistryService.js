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

  const registerBot = async ({ authId = '' } = {}) => {
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
    }, runtimeAuthId);

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

  const listBots = async ({ authId = '' } = {}) => {
    const runtimeAuthId = normalizeAuthId(authId);
    if (!runtimeAuthId) {
      throw new Error('AUTH_ID is required to list bots during install');
    }

    const result = await bitrixClient.callMethodWithAuth('imbot.v2.Bot.list', {
      filter: {
        type: 'bot'
      },
      limit: 50
    }, runtimeAuthId);

    const bots = Array.isArray(result?.bots) ? result.bots : [];
    return bots.map((bot) => ({
      id: parseBotId(bot),
      code: String(bot?.code || ''),
      type: String(bot?.type || ''),
      raw: bot
    }));
  };

  return {
    registerBot,
    listBots
  };
};

export default createBotRegistryService;
