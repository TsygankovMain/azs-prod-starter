/**
 * botCommandHandler — handles Bitrix24 ONIMBOTMESSAGEADD events for the
 * «Указать причину» COMMAND button (BUG-019).
 *
 * State machine (per user/dialog):
 *   idle → [COMMAND button pressed] → awaiting_reason
 *   awaiting_reason → [next plain-text message] → idle  (reason stored)
 *
 * The handler is intentionally stateless itself: it delegates state to
 * the injected reasonCaptureStore.
 */

/**
 * Parse the reportId embedded in a COMMAND string.
 * The command format is: "reason:<reportId>"  e.g. "reason:42"
 *
 * @param {string} command
 * @returns {number} reportId or 0 if not parseable
 */
export const parseReasonCommand = (command) => {
  const str = String(command || '').trim();
  // "reason:42" or "reason_42" or just "42"
  const match = str.match(/(?:reason[_:])?(\d+)/i);
  return match ? Number(match[1]) : 0;
};

/**
 * Build the COMMAND string embedded in the bot keyboard button.
 * Format: "reason:<reportId>"
 *
 * @param {number} reportId
 * @returns {string}
 */
export const buildReasonCommand = (reportId) => `reason:${Number(reportId)}`;

/**
 * @param {{
 *   bitrixClient: object,
 *   reasonStore: object,
 *   reasonCaptureStore: object,
 *   botId?: number,
 *   logger?: object
 * }} deps
 */
export const createBotCommandHandler = ({
  bitrixClient,
  reasonStore,
  reasonCaptureStore,
  botId = Number(process.env.BITRIX_BOT_ID || 0),
  logger = console
}) => {
  if (!bitrixClient || typeof bitrixClient.callMethod !== 'function') {
    throw new Error('botCommandHandler: bitrixClient.callMethod is required');
  }
  if (!reasonStore || typeof reasonStore.upsert !== 'function') {
    throw new Error('botCommandHandler: reasonStore.upsert is required');
  }
  if (!reasonCaptureStore || typeof reasonCaptureStore.setAwaiting !== 'function') {
    throw new Error('botCommandHandler: reasonCaptureStore is required');
  }

  const runtimeBotId = () => Number(botId || process.env.BITRIX_BOT_ID || 0);

  const sendReply = async ({ dialogId, message, context = {} }) => {
    await bitrixClient.callMethod(
      'imbot.v2.Chat.Message.send',
      {
        botId: runtimeBotId(),
        dialogId: String(dialogId),
        fields: { message, urlPreview: false }
      },
      context
    );
  };

  /**
   * Called when the user presses the «Указать причину» COMMAND button.
   * Replies in chat and records awaiting state.
   *
   * @param {{ userId: number, dialogId: string, reportId: number, azsId: string, context?: object }} opts
   */
  const handleCommand = async ({ userId, dialogId, reportId, azsId, context = {} }) => {
    reasonCaptureStore.setAwaiting({ userId, dialogId, reportId, azsId });

    await sendReply({
      dialogId,
      message: 'Напишите причину одним сообщением',
      context
    });

    logger.info('bot_reason_awaiting_set', { userId, dialogId, reportId });
  };

  /**
   * Called on every incoming plain-text message. If the user is in
   * "awaiting reason" state, captures the reason, stores it, confirms,
   * and clears state.
   *
   * @param {{ userId: number, dialogId: string, text: string, context?: object }} opts
   * @returns {Promise<boolean>} true if the message was consumed as a reason
   */
  const handleMessage = async ({ userId, dialogId, text, context = {} }) => {
    const state = reasonCaptureStore.getAwaiting({ userId, dialogId });
    if (!state) {
      return false; // not awaiting — ignore
    }

    const trimmed = String(text || '').trim();
    if (!trimmed) {
      // blank message — do not consume; stay awaiting
      return false;
    }

    // Clear state first so a crash mid-write doesn't leave a stuck state
    reasonCaptureStore.clearAwaiting({ userId, dialogId });

    try {
      await reasonStore.upsert({
        reportId: state.reportId,
        azsId: state.azsId,
        adminUserId: Number(userId),
        reasonCode: 'other',
        reasonText: trimmed,
        source: 'bot'
      });

      await sendReply({
        dialogId,
        message: 'Причина принята.',
        context
      });

      logger.info('bot_reason_captured', { userId, dialogId, reportId: state.reportId });
    } catch (error) {
      logger.warn('bot_reason_capture_failed', {
        userId,
        dialogId,
        reportId: state.reportId,
        error: error?.message || String(error)
      });
      // Best-effort: even if upsert failed, don't re-set state — avoids loops.
      // The user can re-press the button.
    }

    return true;
  };

  return {
    handleCommand,
    handleMessage,
    parseReasonCommand,
    buildReasonCommand
  };
};

export default createBotCommandHandler;
