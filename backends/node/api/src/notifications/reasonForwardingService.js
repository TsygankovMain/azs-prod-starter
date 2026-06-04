const formatLocalTime = (iso, timezone) => {
  if (!iso) return '';
  const tz = String(timezone || '').trim() || 'Europe/Moscow';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
};

const buildForwardMessage = ({ azsTitle, operatorName, reasonLabel, reasonText, reportStatus, deadlineAt, timezone, crmLink }) => {
  const timeStr = formatLocalTime(deadlineAt, timezone);
  const reasonFull = reasonText ? `${reasonLabel}: ${reasonText}` : reasonLabel;
  const lines = [
    `АЗС ${azsTitle}: ${operatorName} — причина: ${reasonFull}.`,
    `Отчёт ${reportStatus}${timeStr ? `, дедлайн был ${timeStr}` : ''}.`
  ];
  if (crmLink) lines.push(crmLink);
  return lines.join('\n');
};

/**
 * createReasonForwardingService — best-effort отправка в общий чат ответственных.
 * chatId берётся из настроек (settings.report.responsibleChatId), не хардкодится.
 */
export const createReasonForwardingService = ({
  bitrixClient,
  botId = Number(process.env.BITRIX_BOT_ID || 0),
  logger = console
}) => {
  if (!bitrixClient) throw new Error('bitrixClient is required');

  const forward = async ({
    settings,
    azsTitle,
    operatorName,
    reasonLabel,
    reasonText = null,
    reportStatus,
    deadlineAt = null,
    timezone = 'Europe/Moscow',
    reportItemId = null,
    portalDomain = '',
    context = {}
  }) => {
    // chatId берётся ТОЛЬКО из настроек, никакого хардкода
    const chatId = String(settings?.report?.responsibleChatId || '').trim();
    if (!chatId) {
      // Деградация: нет chatId — пропускаем пересылку, причина уже записана
      return null;
    }

    const runtimeBotId = Number(botId || process.env.BITRIX_BOT_ID || 0);
    if (!runtimeBotId) {
      logger.warn('reason_forwarding_skipped_no_bot_id', { chatId, reportItemId });
      return null;
    }

    // Строим ссылку на CRM-карточку опционально
    const crmLink = (portalDomain && reportItemId)
      ? `https://${String(portalDomain).replace(/^https?:\/\//, '')}/${reportItemId}/`
      : '';

    const message = buildForwardMessage({
      azsTitle: String(azsTitle || ''),
      operatorName: String(operatorName || ''),
      reasonLabel: String(reasonLabel || ''),
      reasonText: reasonText ? String(reasonText) : null,
      reportStatus: String(reportStatus || ''),
      deadlineAt,
      timezone,
      crmLink
    });

    try {
      const result = await bitrixClient.callMethod(
        'imbot.v2.Chat.Message.send',
        {
          botId: runtimeBotId,
          dialogId: `chat${chatId}`,
          fields: { message, urlPreview: false }
        },
        context
      );
      return { ok: true, result };
    } catch (error) {
      // best-effort: не блокируем захват причины
      logger.warn('reason_forwarding_failed', {
        chatId,
        reportItemId,
        message: String(error?.message || error || '')
      });
      return { ok: false, error: String(error?.message || error || '') };
    }
  };

  return { forward };
};

export default createReasonForwardingService;
