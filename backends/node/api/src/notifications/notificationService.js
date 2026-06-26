export const NOTIFY_FALLBACK_PREFIX = 'delivered via notify fallback: ';

const normalizeMode = (value) => {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'bot' ? 'bot' : 'notify';
};

// Error codes that indicate the bot registration is stale / missing — self-heal applies
const BOT_NOT_FOUND_PATTERN = /BOT_ID|BOT_NOT_FOUND|bot not found/i;

// NOTIF-1: ошибки авторизации бот-доставки. Под webhook imbot.v2.Chat.Message.send
// требует botToken (которого у OAuth-бота нет) → BOT_TOKEN_NOT_SPECIFIED; под OAuth —
// валидный access_token (иначе invalid_client/wrong_client/expired_token, см. BUG-022).
// Такие случаи логируем человеческим actionable-логом, а не тонем в degraded-warn.
const AUTH_PROBLEM_PATTERN = /BOT_TOKEN_NOT_SPECIFIED|invalid_client|wrong_client|expired_token|NO_AUTH_FOUND|Authorization required/i;

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

export const createNotificationService = ({
  bitrixClient,
  mode = process.env.BITRIX_BOT_MODE || 'bot',
  botId = Number(process.env.BITRIX_BOT_ID || 0),
  adminUserIds = [],
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

  const alertAdmins = async ({ botError, userId, azsId, context }) => {
    const ids = Array.isArray(adminUserIds) ? adminUserIds.map(Number).filter(Boolean) : [];
    if (!ids.length) {
      return false;
    }
    const azsPart = azsId ? ` по АЗС ${azsId}` : '';
    const text = `⚠️ Не удалось доставить сообщение сотруднику ${Number(userId)}${azsPart}.\nПричина: ${botError}`;
    let delivered = false;
    for (const adminId of ids) {
      try {
        const bid = await ensureBotId(context);
        if (!bid) {
          break;
        }
        await sendViaBot({ bitrixClient, botId: bid, userId: adminId, message: text, context });
        delivered = true;
      } catch (alertError) {
        if (typeof logger?.error === 'function') {
          logger.error('notification_undelivered', {
            adminId: Number(adminId),
            forUserId: Number(userId),
            azsId: azsId ?? null,
            original: String(botError),
            alertError: alertError?.message || String(alertError)
          });
        }
      }
    }
    return delivered;
  };

  const notify = async ({
    userId,
    message,
    keyboard = null,
    context = {},
    // NOTIF-1: azsId — только для диагностического лога (кому ушла доставка).
    azsId = null
  }) => {
    if (!Number(userId)) {
      throw new Error('notify requires userId');
    }
    if (!String(message || '').trim()) {
      throw new Error('notify requires non-empty message');
    }

    // NOTIF-1 диагностика: webhook-контекст не несёт OAuth `auth`; под ним бот-методы
    // требуют botToken (которого у OAuth-бота нет). transport фиксирует это в логе.
    const transport = context && context.isWebhook ? 'webhook' : 'oauth';
    const logDelivery = (channel, extra = {}) => {
      if (typeof logger?.info === 'function') {
        logger.info('notification_delivery', {
          userId: Number(userId),
          azsId: azsId ?? null,
          channel,
          transport,
          ...extra
        });
      }
    };
    const logAuthProblem = (botError) => {
      if (botError && AUTH_PROBLEM_PATTERN.test(String(botError)) && typeof logger?.error === 'function') {
        logger.error('bot_delivery_auth_problem', {
          userId: Number(userId),
          azsId: azsId ?? null,
          transport,
          botError: String(botError),
          hint: 'Доставка бота без рабочей авторизации: OAuth протух (CLIENT_ID/SECRET — BUG-022) или вызов под webhook без botToken. NOTIF-1.'
        });
      }
    };
    let botError = null;
    try {
      const runtimeBotId = await ensureBotId(context);
      if (!runtimeBotId) {
        throw new Error('BITRIX_BOT_ID is required (bot-only delivery)');
      }
      const trySend = async (bid) => sendViaBot({ bitrixClient, botId: bid, userId, message, keyboard, context });

      let result;
      try {
        result = await trySend(runtimeBotId);
      } catch (firstError) {
        const reason = firstError?.message || String(firstError);
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

      logDelivery('bot');
      return { channel: 'bot', result, delivered: true };
    } catch (error) {
      botError = error?.message || String(error);
      logger.warn('bot_channel_degraded', { reason: botError, dialogId: String(Number(userId)) });
      logAuthProblem(botError);
      const alerted = await alertAdmins({ botError, userId, azsId, context });
      logDelivery(alerted ? 'admin_alert' : 'undelivered', { botError });
      return { channel: alerted ? 'admin_alert' : 'undelivered', delivered: false, botError };
    }
  };

  const notifyDispatch = async ({
    userId,
    azsId,
    azsTitle,
    deadlineAt,
    timezone,
    keyboard = null,
    context = {},
    fallbackSuffix = ''
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
      context,
      azsId,
      fallbackSuffix
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
      context,
      azsId
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
      context,
      azsId
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
