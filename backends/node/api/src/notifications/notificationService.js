const normalizeMode = (value) => {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'bot' ? 'bot' : 'notify';
};

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

const buildDispatchMessage = ({ azsId, deadlineAt, timezone }) => {
  const deadline = formatLocalTime(deadlineAt, timezone);
  const parts = [
    `Время сделать фото-отчёт по АЗС ${String(azsId || '')}.`
  ];
  if (deadline) {
    parts.push(`Сдать до ${deadline}.`);
  }
  parts.push('');
  parts.push('Откройте приложение «Порядок на АЗС» в Bitrix24, чтобы загрузить фото.');
  return parts.join('\n');
};

const buildDoneMessage = ({ azsId }) => `Отчёт по АЗС ${String(azsId || '')} сдан и готов к проверке.`;

const sendViaBot = async ({ bitrixClient, botId, userId, message, keyboard = null, context = {} }) => {
  if (typeof bitrixClient?.callMethod !== 'function') {
    throw new Error('bitrixClient.callMethod is required for bot mode');
  }

  return bitrixClient.callMethod('imbot.v2.Chat.Message.send', {
    botId: Number(botId),
    dialogId: String(Number(userId)),
    fields: {
      message,
      ...(keyboard ? { keyboard } : {}),
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
      try {
        const runtimeBotId = await ensureBotId(context);
        if (!runtimeBotId) {
          throw new Error('BITRIX_BOT_ID is required when BITRIX_BOT_MODE=bot');
        }
        const result = await sendViaBot({
          bitrixClient,
          botId: runtimeBotId,
          userId,
          message,
          keyboard,
          context
        });
        return {
          channel: 'bot',
          result
        };
      } catch (error) {
        logger.warn('Bot notification failed, fallback to im.notify.personal.add', {
          error: error.message
        });
        if (!fallbackToNotify) {
          throw error;
        }
      }
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
    deadlineAt,
    timezone,
    context = {}
  }) => {
    const message = buildDispatchMessage({
      azsId,
      deadlineAt,
      timezone
    });
    return notify({
      userId,
      message,
      context
    });
  };

  const notifyReportDone = async ({
    userId,
    azsId,
    context = {}
  }) => {
    const message = buildDoneMessage({ azsId });
    return notify({
      userId,
      message,
      context
    });
  };

  const notifyReportExpired = async ({ userId, azsId, deadlineAt, timezone, context = {} }) => {
    const deadline = formatLocalTime(deadlineAt, timezone);
    const lines = [
      `Отчёт по АЗС ${String(azsId || '')} не сдан вовремя.`
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
    botId: currentBotId || null,
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
