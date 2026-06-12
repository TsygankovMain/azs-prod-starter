export const NOTIFY_FALLBACK_PREFIX = 'delivered via notify fallback: ';

const normalizeMode = (value) => {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'bot' ? 'bot' : 'notify';
};

// Error codes that indicate the bot registration is stale / missing — self-heal applies
const BOT_NOT_FOUND_PATTERN = /BOT_ID|BOT_NOT_FOUND|bot not found/i;

const formatLocalTime = (iso, timezone) => {
  if (!iso) {
    return '';
  }
  const tz = String(timezone || '').trim() || 'Europe/Moscow';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
};

const buildDispatchMessage = ({ azsId, azsTitle, deadlineAt, timezone }) => {
  const deadline = formatLocalTime(deadlineAt, timezone);
  const label = String(azsTitle || '').trim() || String(azsId || '').trim();
  const parts = [
    `Время сделать фото-отчёт по АЗС ${label}.`
  ];
  if (deadline) {
    parts.push(`Сдать до ${deadline}.`);
  }
  parts.push('');
  parts.push('Откройте приложение «Порядок на АЗС» в Битрикс24, чтобы загрузить фото.');
  return parts.join('\n');
};

const buildDoneMessage = ({ azsId, azsTitle }) => {
  const label = String(azsTitle || '').trim() || String(azsId || '').trim();
  return `Отчёт по АЗС ${label} сдан и готов к проверке.`;
};

const sendViaBot = async ({ bitrixClient, botId, userId, message, keyboard = null, context = {} }) => {
  if (typeof bitrixClient?.callMethod !== 'function') {
    throw new Error('bitrixClient.callMethod is required for bot mode');
  }

  return bitrixClient.callMethod('imbot.v2.Chat.Message.send', {
    botId: Number(botId),
    dialogId: String(Number(userId)),
    fields: {
      message,
      ...(keyboard != null ? { keyboard } : {}),
      urlPreview: true
    }
  }, context);
};

const sendViaNotify = async ({ bitrixClient, userId, message, context = {} }) => {
  if (typeof bitrixClient?.notifyUser !== 'function') {
    throw new Error('bitrixClient.notifyUser is required for notify mode');
  }
  return bitrixClient.notifyUser({
    userId: Number(userId),
    message,
    context
  });
};

export const createNotificationService = ({
  bitrixClient,
  mode = process.env.BITRIX_BOT_MODE || 'notify',
  botId = Number(process.env.BITRIX_BOT_ID || 0),
  appCode = process.env.BITRIX_APP_CODE || '',
  publicBaseUrl = process.env.APP_PUBLIC_BASE_URL || process.env.VIRTUAL_HOST || '',
  resolveBotId = null,
  ensureBot = null,
  logger = console
}) => {
  if (!bitrixClient) {
    throw new Error('bitrixClient is required');
  }

  const resolvedMode = normalizeMode(mode);
  const resolvedBotId = Number(botId);
  let currentBotId = Number.isFinite(resolvedBotId) ? resolvedBotId : 0;

  const ensureBotId = async (context = {}) => {
    if (currentBotId) {
      return currentBotId;
    }
    if (typeof resolveBotId !== 'function') {
      return 0;
    }

    const nextBotId = Number(await resolveBotId(context));
    if (Number.isFinite(nextBotId) && nextBotId > 0) {
      currentBotId = Math.floor(nextBotId);
      process.env.BITRIX_BOT_ID = String(currentBotId);
    }
    return currentBotId;
  };

  const notify = async ({ userId, message, keyboard = null, context = {}, fallbackToNotify = true }) => {
    if (!Number(userId)) {
      throw new Error('notify requires userId');
    }
    if (!String(message || '').trim()) {
      throw new Error('notify requires non-empty message');
    }

    if (resolvedMode === 'bot') {
      let botError = null;
      try {
        const runtimeBotId = await ensureBotId(context);
        if (!runtimeBotId) {
          throw new Error('BITRIX_BOT_ID is required when BITRIX_BOT_MODE=bot');
        }

        const trySend = async (bid) => sendViaBot({
          bitrixClient,
          botId: bid,
          userId,
          message,
          keyboard,
          context
        });

        let result;
        try {
          result = await trySend(runtimeBotId);
        } catch (firstError) {
          const reason = firstError?.message || String(firstError);
          // Self-heal: only for BOT_ID / BOT_NOT_FOUND errors, never for PARAM_* errors
          if (BOT_NOT_FOUND_PATTERN.test(reason) && typeof ensureBot === 'function') {
            logger.warn('bot_self_heal_triggered', { reason, userId });
            const healed = await ensureBot(context);
            const healedBotId = Number(healed?.botId || 0);
            if (healedBotId) {
              currentBotId = healedBotId;
              result = await trySend(healedBotId);
            } else {
              throw firstError;
            }
          } else {
            throw firstError;
          }
        }

        return {
          channel: 'bot',
          result,
          delivered: true
        };
      } catch (error) {
        botError = error?.message || String(error);
        logger.warn('bot_channel_degraded', {
          reason: botError,
          dialogId: String(Number(userId))
        });
        if (!fallbackToNotify) {
          throw error;
        }
      }

      // Fallback path — bot failed
      const notifyResult = await sendViaNotify({ bitrixClient, userId, message, context });
      return {
        delivered: true,
        channel: 'notify',
        result: notifyResult,
        botError
      };
    }

    const result = await sendViaNotify({ bitrixClient, userId, message, context });
    return {
      channel: 'notify',
      result
    };
  };

  const notifyDispatch = async ({
    userId,
    azsId,
    azsTitle,
    deadlineAt,
    timezone,
    keyboard = null,
    context = {}
  }) => {
    const message = buildDispatchMessage({
      azsId,
      azsTitle,
      deadlineAt,
      timezone
    });
    return notify({
      userId,
      message,
      keyboard,
      context
    });
  };

  const notifyReportDone = async ({
    userId,
    azsId,
    azsTitle,
    context = {}
  }) => {
    const message = buildDoneMessage({ azsId, azsTitle });
    return notify({
      userId,
      message,
      context
    });
  };

  const notifyReportExpired = async ({ userId, azsId, azsTitle, deadlineAt, timezone, context = {} }) => {
    const deadline = formatLocalTime(deadlineAt, timezone);
    const label = String(azsTitle || '').trim() || String(azsId || '').trim();
    const lines = [
      `Отчёт по АЗС ${label} не сдан вовремя.`
    ];
    if (deadline) {
      lines.push(`Срок сдачи был до ${deadline}.`);
    }
    return notify({
      userId,
      message: lines.join('\n'),
      context
    });
  };

  return {
    mode: resolvedMode,
    get botId() { return currentBotId || null; },
    setBotId(nextBotId) {
      const parsed = Number(nextBotId);
      if (Number.isFinite(parsed) && parsed > 0) {
        currentBotId = Math.floor(parsed);
      }
      return currentBotId;
    },
    notify,
    notifyDispatch,
    notifyReportDone,
    notifyReportExpired
  };
};

export default createNotificationService;
