import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

const loadBuiltInBotAvatar = () => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const avatarPath = resolve(here, 'assets', 'bot-avatar.png');
    const bytes = readFileSync(avatarPath);
    return bytes.toString('base64');
  } catch {
    return '';
  }
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

  const builtInAvatarBase64 = loadBuiltInBotAvatar();

  const buildProperties = () => {
    const properties = {
      name: String(botName).trim(),
      workPosition: String(botWorkPosition).trim()
    };
    if (builtInAvatarBase64) {
      properties.avatar = builtInAvatarBase64;
    }
    return properties;
  };

  const registerBot = async ({ authId = '', context = {} } = {}) => {
    const runtimeAuthId = normalizeAuthId(authId);
    if (!runtimeAuthId) {
      throw new Error('AUTH_ID is required to register bot during install');
    }

    const result = await bitrixClient.callMethodWithAuth('imbot.v2.Bot.register', {
      fields: {
        code: String(botCode).trim(),
        properties: buildProperties(),
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

  const updateBotAvatar = async ({ botId, authId = '', context = {} }) => {
    if (!builtInAvatarBase64 || !Number(botId)) {
      return false;
    }
    const runtimeAuthId = normalizeAuthId(authId);
    if (!runtimeAuthId) {
      return false;
    }
    try {
      await bitrixClient.callMethodWithAuth('imbot.v2.Bot.update', {
        botId: Number(botId),
        fields: {
          properties: buildProperties()
        }
      }, runtimeAuthId, context);
      logger.info('bot avatar refreshed', { botId });
      return true;
    } catch (error) {
      logger.warn('bot avatar refresh failed', { botId, error: error.message });
      return false;
    }
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
      await updateBotAvatar({ botId: existing.id, authId: runtimeAuthId, context });
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
    ensureBot,
    updateBotAvatar
  };
};

export default createBotRegistryService;
