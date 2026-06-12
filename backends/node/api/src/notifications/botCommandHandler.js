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
  // Optional best-effort side-effects hook fired AFTER a reason is captured and
  // confirmed: writes the reason to the CRM report card and forwards it to the
  // responsible chat — parity with the app path (POST /:id/reason). Injected from
  // server.js where settings/forwarding/CRM deps are available. Never blocks or
  // breaks the «Причина принята» reply.
  onReasonCaptured = null,
  // Optional async provider of the reason catalog [{code,label}] from settings.
  // When present, handleCommand offers quick-reply buttons and handleMessage maps
  // a tapped/typed label back to its reasonCode (else falls back to 'other').
  getReasons = null,
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

  const sendReply = async ({ dialogId, message, keyboard = null, context = {} }) => {
    const fields = { message, urlPreview: false };
    if (keyboard) {
      fields.keyboard = keyboard;
    }
    await bitrixClient.callMethod(
      'imbot.v2.Chat.Message.send',
      {
        botId: runtimeBotId(),
        dialogId: String(dialogId),
        fields
      },
      context
    );
  };

  // Load the reason catalog [{code,label}] via the injected provider (best-effort).
  const loadReasons = async () => {
    if (typeof getReasons !== 'function') return [];
    try {
      const list = await getReasons();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  // Map a tapped/typed text back to a catalog reasonCode. An exact label match
  // (case-insensitive) to a non-«other» reason yields its code; anything else is
  // free text under «other».
  const resolveReason = (text, reasons) => {
    const t = String(text || '').trim().toLowerCase();
    const match = (reasons || []).find(
      (r) => String(r?.label || '').trim().toLowerCase() === t
    );
    if (match && String(match.code) !== 'other') {
      return { reasonCode: String(match.code), reasonText: null };
    }
    return { reasonCode: 'other', reasonText: String(text || '').trim() };
  };

  /**
   * Called when the user presses the «Указать причину» COMMAND button.
   * Replies in chat and records awaiting state.
   *
   * @param {{ userId: number, dialogId: string, reportId: number, azsId: string, context?: object }} opts
   */
  const handleCommand = async ({ userId, dialogId, reportId, azsId, context = {} }) => {
    reasonCaptureStore.setAwaiting({ userId, dialogId, reportId, azsId });

    // Quick-reply buttons from the reason catalog (ACTION:SEND sends the label as
    // a message → handleMessage maps it back to a code). Faster than typing; the
    // user can still type a free-form reason.
    const reasons = await loadReasons();
    const buttons = reasons
      .map((r) => String(r?.label || '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((label) => ({ TEXT: label, ACTION: 'SEND', ACTION_VALUE: label }));
    const keyboard = buttons.length ? { BOT_ID: runtimeBotId(), BUTTONS: buttons } : null;

    await sendReply({
      dialogId,
      message: buttons.length
        ? 'Выберите причину или напишите свою:'
        : 'Напишите причину одним сообщением',
      keyboard,
      context
    });

    logger.info('bot_reason_awaiting_set', { userId, dialogId, reportId, options: buttons.length });
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

    // Map the text to a catalog reason code when it matches a known label.
    const reasons = await loadReasons();
    const { reasonCode, reasonText } = resolveReason(trimmed, reasons);

    try {
      await reasonStore.upsert({
        reportId: state.reportId,
        azsId: state.azsId,
        adminUserId: Number(userId),
        reasonCode,
        reasonText,
        source: 'bot'
      });

      await sendReply({
        dialogId,
        message: 'Причина принята.',
        context
      });

      logger.info('bot_reason_captured', { userId, dialogId, reportId: state.reportId });

      // Best-effort side-effects (CRM card + forward to chat). Must NOT break the
      // capture or the confirmation reply above — those already succeeded.
      if (typeof onReasonCaptured === 'function') {
        try {
          await onReasonCaptured({
            reportId: state.reportId,
            azsId: state.azsId,
            userId: Number(userId),
            reasonCode,
            reasonText
          });
        } catch (sideError) {
          logger.warn('bot_reason_sideeffects_failed', {
            userId,
            dialogId,
            reportId: state.reportId,
            error: sideError?.message || String(sideError)
          });
        }
      }
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
