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

/**
 * Build the bot event handler URL that Bitrix24 will POST to when a message
 * arrives (ONIMBOTMESSAGEADD).  The URL carries a shared secret so that
 * /api/bot/event can verify the request originated from Bitrix24.
 *
 * @param {string} base  - APP_BASE_URL without trailing slash, e.g. "https://app.example.com"
 * @param {string} secret - JOB_SECRET value; empty string → no ?s= param appended
 * @returns {string} full handler URL or empty string if base is empty
 */
const buildBotEventHandlerUrl = (base, secret) => {
  if (!base) return '';
  const trimmed = base.replace(/\/+$/, '');
  const path = `${trimmed}/api/bot/event`;
  return secret ? `${path}?s=${encodeURIComponent(secret)}` : path;
};

export const createBotRegistryService = ({
  bitrixClient,
  logger = console,
  botCode = process.env.BITRIX_BOT_CODE || 'azs_order_bot',
  botName = process.env.BITRIX_BOT_NAME || 'Порядок на АЗС',
  botWorkPosition = process.env.BITRIX_BOT_WORK_POSITION || 'Фото-отчёты АЗС',
  // handlerBaseUrl: base URL for the bot event handler (APP_BASE_URL / VIRTUAL_HOST).
  // If not provided, falls back to process.env.APP_BASE_URL or VIRTUAL_HOST.
  handlerBaseUrl = process.env.APP_BASE_URL || process.env.VIRTUAL_HOST || '',
  // jobSecret: shared secret appended as ?s= to the event handler URL.
  // Defaults to process.env.JOB_SECRET.
  jobSecret = process.env.JOB_SECRET || ''
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

    // Build the event handler URL that Bitrix24 will POST to for ONIMBOTMESSAGEADD.
    // The URL carries JOB_SECRET as ?s= so the endpoint can verify origin.
    const eventHandlerUrl = buildBotEventHandlerUrl(
      String(handlerBaseUrl || '').replace(/\/+$/, ''),
      String(jobSecret || '')
    );

    if (!eventHandlerUrl) {
      logger.warn('botRegistryService: APP_BASE_URL/VIRTUAL_HOST not set — registering bot WITHOUT event handler URL');
    } else if (!jobSecret) {
      logger.warn('botRegistryService: JOB_SECRET not set — event handler URL registered WITHOUT secret (endpoint is UNVERIFIED)');
    }

    const fields = {
      code: String(botCode).trim(),
      properties: buildProperties(),
      type: 'bot',
      eventMode: 'fetch'
    };

    // Attach event handler URL when available (Bitrix24 imbot.v2.Bot.register
    // accepts event_message_add to register the ONIMBOTMESSAGEADD handler URL).
    if (eventHandlerUrl) {
      fields.event_message_add = eventHandlerUrl;
    }

    const result = await bitrixClient.callMethodWithAuth('imbot.v2.Bot.register', {
      fields
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

  const ensureBot = async ({ authId = '', context = {}, force = false } = {}) => {
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

    // force=true: skip reuse — call registerBot again to re-bind the bot to the
    // portal. No unregister is issued so existing chats and history are preserved.
    // Bitrix24 imbot.v2.Bot.register is idempotent for the same code: it returns
    // the existing botId (or creates a new one) and updates the stored properties.
    if (existing && !force) {
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

    if (existing && force) {
      logger.info('bot force-reregister', { previousBotId: existing.id, botCode: expectedCode });
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
