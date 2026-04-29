import { buildReportLinks } from './reportLinks.js';

const normalizeMode = (value) => {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'bot' ? 'bot' : 'notify';
};

const buildDispatchMessage = ({ azsId, slotHHmm, deadlineAt, links }) => {
  const lines = [
    'Порядок на АЗС',
    `Новый фото-отчёт для АЗС ${String(azsId || '')}.`,
    `Слот: ${slotHHmm}.`,
    `Дедлайн: ${new Date(deadlineAt).toISOString()}.`
  ];

  if (links.restAppUriLink) {
    lines.push(`Открыть отчёт: ${links.restAppUriLink}`);
  } else if (links.publicReportUrl) {
    lines.push(`Открыть отчёт: ${links.publicReportUrl}`);
  } else {
    lines.push(`Открыть отчёт: ${links.appPath}`);
  }

  return lines.join('\n');
};

const buildDoneMessage = ({ azsId, links }) => {
  const lines = [
    `Отчёт АЗС ${String(azsId || '')} завершён и готов к проверке.`
  ];

  if (links.restAppUriLink) {
    lines.push(`Открыть отчёт: ${links.restAppUriLink}`);
  } else if (links.publicReportUrl) {
    lines.push(`Открыть отчёт: ${links.publicReportUrl}`);
  } else {
    lines.push(`Открыть отчёт: ${links.appPath}`);
  }

  return lines.join('\n');
};

const sendViaBot = async ({ bitrixClient, botId, userId, message }) => {
  if (typeof bitrixClient?.callMethod !== 'function') {
    throw new Error('bitrixClient.callMethod is required for bot mode');
  }

  return bitrixClient.callMethod('imbot.v2.Chat.Message.send', {
    botId: Number(botId),
    dialogId: String(Number(userId)),
    fields: {
      message,
      urlPreview: true
    }
  });
};

const sendViaNotify = async ({ bitrixClient, userId, message }) => {
  if (typeof bitrixClient?.notifyUser !== 'function') {
    throw new Error('bitrixClient.notifyUser is required for notify mode');
  }
  return bitrixClient.notifyUser({
    userId: Number(userId),
    message
  });
};

export const createNotificationService = ({
  bitrixClient,
  mode = process.env.BITRIX_BOT_MODE || 'notify',
  botId = Number(process.env.BITRIX_BOT_ID || 0),
  appCode = process.env.BITRIX_APP_CODE || '',
  publicBaseUrl = process.env.APP_PUBLIC_BASE_URL || process.env.VIRTUAL_HOST || '',
  logger = console
}) => {
  if (!bitrixClient) {
    throw new Error('bitrixClient is required');
  }

  const resolvedMode = normalizeMode(mode);
  const resolvedBotId = Number(botId);

  const notify = async ({ userId, message, fallbackToNotify = true }) => {
    if (!Number(userId)) {
      throw new Error('notify requires userId');
    }
    if (!String(message || '').trim()) {
      throw new Error('notify requires non-empty message');
    }

    if (resolvedMode === 'bot') {
      if (!resolvedBotId) {
        throw new Error('BITRIX_BOT_ID is required when BITRIX_BOT_MODE=bot');
      }
      try {
        const result = await sendViaBot({
          bitrixClient,
          botId: resolvedBotId,
          userId,
          message
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

    const result = await sendViaNotify({ bitrixClient, userId, message });
    return {
      channel: 'notify',
      result
    };
  };

  const notifyDispatch = async ({
    userId,
    reportId,
    azsId,
    slotHHmm,
    deadlineAt
  }) => {
    const links = buildReportLinks({
      appCode,
      reportId,
      publicBaseUrl
    });
    const message = buildDispatchMessage({
      azsId,
      slotHHmm,
      deadlineAt,
      links
    });
    return notify({ userId, message });
  };

  const notifyReportDone = async ({
    userId,
    reportId,
    azsId
  }) => {
    const links = buildReportLinks({
      appCode,
      reportId,
      publicBaseUrl
    });
    const message = buildDoneMessage({ azsId, links });
    return notify({ userId, message });
  };

  const notifyReportExpired = async ({ userId, reportId, azsId, slotKey }) => {
    const links = buildReportLinks({
      appCode,
      reportId,
      publicBaseUrl
    });
    const lines = [
      `Отчёт АЗС ${String(azsId || '')} просрочен (slot ${String(slotKey || '-')}).`
    ];
    if (links.restAppUriLink) {
      lines.push(`Открыть отчёт: ${links.restAppUriLink}`);
    }
    return notify({ userId, message: lines.join('\n') });
  };

  return {
    mode: resolvedMode,
    botId: resolvedBotId || null,
    notify,
    notifyDispatch,
    notifyReportDone,
    notifyReportExpired
  };
};

export default createNotificationService;
