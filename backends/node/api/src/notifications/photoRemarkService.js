/**
 * photoRemarkService — sends photo remarks via Bitrix24 bot and writes to the journal.
 *
 * createPhotoRemarkService({ bitrixClient, remarkStore, reportsStore, settingsStore,
 *                             getAdminContext, mode, botId })
 *   → { sendRemark({ azsId, azsTitle, recipientRole, message, photos, sender }) }
 *
 * PHOTO_FORWARD_MODE:
 *   'bot'    (default) — imbot.v2.File.upload per file; text on first file only
 *   'commit'           — im.disk.file.commit with all FILE_ID[] under admin context
 *
 * photos: Array<{ reportId: number, photoCode: string }>
 * sender: { id: number, name: string | null }
 *
 * Returns the journal record (from remarkStore).
 * Always writes a journal record — 'failed' on error, 'sent' on success.
 */

import { resolveAzsRecipients } from '../reports/azsRecipients.js';
import { RECIPIENT_NOT_SET } from '../reports/errorCodes.js';

const resolveMode = (envValue) => {
  const v = String(envValue || '').trim().toLowerCase();
  return v === 'commit' ? 'commit' : 'bot';
};

const buildRemarkText = ({ azsTitle, senderName, message }) => {
  const label = String(azsTitle || '').trim() || '';
  const from = String(senderName || '').trim();
  const text = String(message || '').trim();
  const prefix = label ? `Замечание по АЗС ${label}` : 'Замечание';
  const suffix = from ? ` (${from})` : '';
  return `${prefix}${suffix}: ${text}`;
};

export const createPhotoRemarkService = ({
  bitrixClient,
  remarkStore,
  reportsStore,
  settingsStore,
  getAdminContext,
  mode: modeOverride = null,
  botId: botIdOverride = null
}) => {
  if (!bitrixClient) throw new Error('bitrixClient is required');
  if (!remarkStore) throw new Error('remarkStore is required');
  if (!reportsStore) throw new Error('reportsStore is required');
  if (!settingsStore) throw new Error('settingsStore is required');

  const resolveAdminContext = async (fallback = {}) => {
    if (typeof getAdminContext === 'function') {
      try {
        const ctx = await getAdminContext();
        if (ctx) return ctx;
      } catch {
        // best-effort
      }
    }
    return fallback;
  };

  /**
   * sendRemark — main entry point.
   *
   * @param {object} params
   * @param {string}  params.azsId
   * @param {string}  [params.azsTitle]
   * @param {'manager'|'admin'} params.recipientRole
   * @param {string}  params.message
   * @param {Array<{reportId:number, photoCode:string}>} params.photos  max 20
   * @param {{id:number, name:string|null}} params.sender
   * @returns {Promise<object>} — journal record
   */
  const sendRemark = async ({
    azsId,
    azsTitle = null,
    recipientRole,
    message,
    photos = [],
    sender = {}
  }) => {
    // -----------------------------------------------------------------------
    // 1. Resolve recipient
    // -----------------------------------------------------------------------
    const settings = await settingsStore.read();
    const adminContext = await resolveAdminContext();

    const { manager, admin } = await resolveAzsRecipients({
      azsId,
      settings,
      bitrixClient,
      context: adminContext
    });

    const recipient = recipientRole === 'manager' ? manager : admin;
    if (!recipient || !recipient.id) {
      const err = new Error(`Recipient role "${recipientRole}" is not configured for AZS ${azsId}`);
      err.errorCode = RECIPIENT_NOT_SET;
      throw err;
    }

    const mode = resolveMode(modeOverride ?? process.env.PHOTO_FORWARD_MODE);
    const botId = Number(botIdOverride ?? process.env.BITRIX_BOT_ID ?? 0);
    const remarkText = buildRemarkText({ azsTitle, senderName: sender?.name, message });

    // -----------------------------------------------------------------------
    // 2. Insert journal record (initial status 'sent', will be overwritten on failure)
    // -----------------------------------------------------------------------
    const record = await remarkStore.insertRemark({
      azsId,
      azsTitle: azsTitle ?? null,
      recipientRole,
      recipientUserId: recipient.id,
      recipientName: recipient.name ?? null,
      message,
      senderUserId: sender?.id ?? null,
      senderName: sender?.name ?? null,
      photos
    });

    // -----------------------------------------------------------------------
    // 3. Send
    // -----------------------------------------------------------------------
    try {
      if (mode === 'commit') {
        // ------------------------------------------------------------------
        // commit mode: im.disk.file.commit with all disk_object_ids
        // ------------------------------------------------------------------
        const fileIds = [];
        for (const { reportId, photoCode } of photos) {
          const photo = await reportsStore.getPhoto(reportId, photoCode);
          if (photo?.diskObjectId) {
            fileIds.push(photo.diskObjectId);
          }
        }

        await bitrixClient.callMethod('im.disk.file.commit', {
          DIALOG_ID: String(recipient.id),
          FILE_ID: fileIds,
          MESSAGE: remarkText
        }, adminContext);
      } else {
        // ------------------------------------------------------------------
        // bot mode: imbot.v2.File.upload per file
        // ------------------------------------------------------------------
        if (!botId) {
          throw new Error('BITRIX_BOT_ID is required for PHOTO_FORWARD_MODE=bot');
        }

        let isFirst = true;
        for (const { reportId, photoCode } of photos) {
          const photo = await reportsStore.getPhoto(reportId, photoCode);
          if (!photo?.diskObjectId) continue;

          const { base64, name } = await bitrixClient.diskApi.downloadFileContent(
            photo.diskObjectId,
            adminContext
          );

          const fields = {
            FILE: {
              name: photo.fileName || name,
              content: base64
            }
          };
          if (isFirst) {
            fields.FILE.message = remarkText;
            isFirst = false;
          }

          await bitrixClient.callMethod('imbot.v2.File.upload', {
            botId: Number(botId),
            dialogId: String(recipient.id),
            fields
          }, adminContext);
        }
      }

      // success — update record delivery status
      await remarkStore.markDelivery(record.id, 'sent', null);
      return { ...record, deliveryStatus: 'sent', deliveryError: null };
    } catch (err) {
      const errorText = String(err?.message || err || 'unknown error').slice(0, 1000);
      await remarkStore.markDelivery(record.id, 'failed', errorText);
      return { ...record, deliveryStatus: 'failed', deliveryError: errorText };
    }
  };

  return { sendRemark };
};

export default createPhotoRemarkService;
