import { buildReportLinks } from './reportLinks.js';

const normalizeMode = (value) => {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'bot' ? 'bot' : 'notify';
};

const resolveOpenReportLink = (links) => {
  if (links.restAppUriLink) {
    return links.restAppUriLink;
  }
  if (links.publicReportUrl) {
    return links.publicReportUrl;
  }
  return links.appPath;
};

const buildOpenReportKeyboard = (links) => {
  const link = resolveOpenReportLink(links);
  return {
    BUTTONS: [
      {
        TEXT: 'Открыть отчёт',
        LINK: link,
        DISPLAY: 'BLOCK',
        BG_COLOR_TOKEN: 'primary'
      }
    ]
  };
};

const buildDispatchMessage = ({ azsId, slotHHmm, deadlineAt, links }) => {
  const lines = [
    'Порядок на АЗС',
    `Новый фото-отчёт для АЗС ${String(azsId || '')}.`,
    `Слот: ${slotHHmm}.`,
    `Дедлайн: ${new Date(deadlineAt).toISOString()}.`
  ];

  return lines.join('\n');
};

const buildDoneMessage = ({ azsId, links }) => {
  const lines = [
    `Отчёт АЗС ${String(azsId || '')} завершён и готов к проверке.`
  ];

  return lines.join('\n');
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
  logger = console
}) => {
  if (!bitrixClient) {
    throw new Error('bitrixClient is required');
  }

  const resolvedMode = normalizeMode(mode);
  const resolvedBotId = Number(botId);
  let currentBotId = Number.isFinite(resolvedBotId) ? resolvedBotId : 0;

  const notify = async ({ userId, message, keyboard = null, context = {}, fallbackToNotify = true }) => {
    if (!Number(userId)) {
      throw new Error('notify requires userId');
    }
    if (!String(message || '').trim()) {
      throw new Error('notify requires non-empty message');
    }

    if (resolvedMode === 'bot') {
      if (!currentBotId) {
        throw new Error('BITRIX_BOT_ID is required when BITRIX_BOT_MODE=bot');
      }
      try {
        const result = await sendViaBot({
          bitrixClient,
          botId: currentBotId,
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
    reportId,
    azsId,
    slotHHmm,
    deadlineAt,
    context = {}
  }) => {
    const links = buildReportLinks({
      appCode,
      reportId,
      publicBaseUrl,
      portalDomain: context?.domain || ''
    });
    const message = buildDispatchMessage({
      azsId,
      slotHHmm,
      deadlineAt,
      links
    });
    return notify({
      userId,
      message,
      context,
      keyboard: buildOpenReportKeyboard(links)
    });
  };

  const notifyReportDone = async ({
    userId,
    reportId,
    azsId,
    context = {}
  }) => {
    const links = buildReportLinks({
      appCode,
      reportId,
      publicBaseUrl,
      portalDomain: context?.domain || ''
    });
    const message = buildDoneMessage({ azsId, links });
    return notify({
      userId,
      message,
      context,
      keyboard: buildOpenReportKeyboard(links)
    });
  };

  const notifyReportExpired = async ({ userId, reportId, azsId, slotKey, context = {} }) => {
    const links = buildReportLinks({
      appCode,
      reportId,
      publicBaseUrl,
      portalDomain: context?.domain || ''
    });
    const lines = [
      `Отчёт АЗС ${String(azsId || '')} просрочен (slot ${String(slotKey || '-')}).`
    ];
    return notify({
      userId,
      message: lines.join('\n'),
      context,
      keyboard: buildOpenReportKeyboard(links)
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
